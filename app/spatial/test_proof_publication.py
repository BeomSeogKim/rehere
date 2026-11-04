"""Sandbox proof publication: complete or absent, never partial, never overwriting.

No subprocess, model or psutil is needed; this covers the window in which the
supervisor once parsed an empty sandbox.json.
"""
import inspect
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import full_object_supervisor as supervisor

PROOF = {"nonce": "a" * 32, "pid": 101, "pgid": 101, "networkDenied": True, "watchdogPid": 102}


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.path = self.dir / "sandbox.json"

    def names(self):
        return sorted(p.name for p in self.dir.iterdir())

    def test_publishes_complete_private_json_and_leaves_no_temporary_name(self):
        supervisor.publish(self.path, PROOF)
        self.assertEqual(json.loads(self.path.read_text()), PROOF)
        self.assertEqual(stat.S_IMODE(self.path.lstat().st_mode), 0o600)
        self.assertEqual(self.path.lstat().st_nlink, 1)
        self.assertEqual(self.names(), ["sandbox.json"])

    def test_the_name_is_absent_while_the_bytes_are_written(self):
        seen = []
        real_dump = json.dump

        def observed(data, stream, **kwargs):
            seen.append(self.path.exists())
            real_dump(data, stream, **kwargs)
            stream.flush()
            # Even with every byte written, the polled name is not there yet.
            seen.append(self.path.exists())

        with patch.object(supervisor.json, "dump", observed):
            supervisor.publish(self.path, PROOF)
        self.assertEqual(seen, [False, False])
        self.assertEqual(json.loads(self.path.read_text()), PROOF)

    def test_a_stop_before_publication_leaves_no_proof_and_no_temporary_name(self):
        with patch.object(supervisor.os, "link", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            supervisor.publish(self.path, PROOF)
        self.assertEqual(self.names(), [])

    def assert_exists_stop(self):
        with self.assertRaises(supervisor.Stop) as caught:
            supervisor.publish(self.path, PROOF)
        self.assertEqual(str(caught.exception), "sandbox_proof_exists")

    def test_never_overwrites_an_existing_file(self):
        self.path.write_text("earlier")
        self.assert_exists_stop()
        self.assertEqual(self.path.read_text(), "earlier")
        self.assertEqual(self.names(), ["sandbox.json"])

    def test_never_writes_through_or_replaces_a_symlink(self):
        outside = self.dir / "outside"
        outside.mkdir()
        target = outside / "target.json"
        target.write_text("outside")
        for name, destination in (("live", target), ("dangling", outside / "missing.json")):
            with self.subTest(name):
                if self.path.is_symlink():
                    self.path.unlink()
                self.path.symlink_to(destination)
                self.assert_exists_stop()
                self.assertTrue(self.path.is_symlink())
                self.assertEqual(target.read_text(), "outside")
                self.assertFalse((outside / "missing.json").exists())
                self.assertEqual([p.name for p in self.dir.iterdir() if p.name.endswith(".tmp")], [])

    def test_a_taken_temporary_name_stops_and_is_left_alone(self):
        with patch.object(supervisor.secrets, "token_hex", return_value="0" * 16):
            taken = self.dir / f".sandbox.json.{os.getpid()}.{'0' * 16}.tmp"
            taken.write_text("someone else's")
            self.assert_exists_stop()
        self.assertEqual(taken.read_text(), "someone else's")
        self.assertFalse(self.path.exists())

    def test_a_failed_write_removes_its_partial_temporary_copy(self):
        with patch.object(supervisor.json, "dump", side_effect=ValueError("synthetic")), self.assertRaises(ValueError):
            supervisor.publish(self.path, PROOF)
        self.assertEqual(self.names(), [])

    def test_syncs_the_directory_after_publishing(self):
        synced = []
        real_fsync = os.fsync

        def recording(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            return real_fsync(fd)

        with patch.object(supervisor.os, "fsync", recording):
            supervisor.publish(self.path, PROOF)
        self.assertEqual(synced, [False, True])

    def test_the_temporary_name_is_created_exclusively_without_following_links(self):
        flags = []
        real_open = os.open

        def recording(path, flag, *args):
            flags.append((Path(path).name, flag))
            return real_open(path, flag, *args)

        with patch.object(supervisor.os, "open", recording):
            supervisor.publish(self.path, PROOF)
        self.assertEqual(len(flags), 2)
        (name, flag), (directory, directory_flag) = flags
        self.assertTrue(name.startswith(".sandbox.json.") and name.endswith(".tmp"))
        for required in (os.O_CREAT, os.O_EXCL, os.O_NOFOLLOW):
            self.assertTrue(flag & required)
        # The second open only syncs the directory; it creates nothing.
        self.assertEqual(directory, self.dir.name)
        self.assertTrue(directory_flag & os.O_DIRECTORY)
        self.assertFalse(directory_flag & (os.O_CREAT | os.O_WRONLY | os.O_RDWR))

    def test_the_worker_child_publishes_its_proof_and_other_files_still_use_save(self):
        child = inspect.getsource(supervisor.child)
        self.assertIn('publish(attempt / "sandbox.json"', child)
        self.assertNotIn('save(attempt / "sandbox.json"', child)
        supervise = inspect.getsource(supervisor.supervise)
        self.assertNotIn("publish(", supervise)


if __name__ == "__main__":
    unittest.main()
