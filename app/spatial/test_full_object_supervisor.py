"""Dummy-process tests; synthetic resources and no claimed OS sandbox admission."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import psutil

import full_object_supervisor as supervisor


class DummyHost(supervisor.Host):
    def __init__(self, probe=True, startup_delay=0):
        self.psutil, self.launches, self.samples, self.proc = psutil, 0, 0, None
        self.probe = probe
        self.startup_delay = startup_delay

    def preflight(self):
        pass

    def sample(self, output):
        self.samples += 1
        return {"pressure": 75, "available": 8 * supervisor.GIB, "swap_used": 0,
                "swap_free": 2 * supervisor.GIB, "disk_free": 20 * supervisor.GIB}

    def members(self, pgid):
        members = []
        known = {pgid}
        if hasattr(self, "children_path") and self.children_path.exists():
            known.update(json.loads(self.children_path.read_text()))
        if hasattr(self, "sandbox_path") and self.sandbox_path.exists():
            known.add(json.loads(self.sandbox_path.read_text())["watchdogPid"])
        # Only fixture-declared PIDs; this is not the production group sampler.
        for pid in known:
            try:
                if os.getpgid(pid) == pgid:
                    proc = psutil.Process(pid)
                    members.append({"pid": pid, "rss": proc.memory_info().rss, "uid": proc.uids().real})
            except (ProcessLookupError, psutil.NoSuchProcess):
                continue
            except PermissionError:
                if psutil.Process(pid).status() != psutil.STATUS_ZOMBIE:
                    raise
        return members

    def launch(self, config_path, log, env, life_fd):
        self.launches += 1
        self.children_path = config_path.parent / "dummy-children.json"
        self.sandbox_path = config_path.parent / "sandbox.json"
        probe = 'lambda: None' if self.probe else 'lambda: (_ for _ in ()).throw(s.Stop("synthetic_denial_unavailable"))'
        bootstrap = ("import sys,time;time.sleep(" + repr(self.startup_delay) + ");sys.path.insert(0," + repr(str(Path(supervisor.__file__).parent))
                     + "); import full_object_supervisor as s; s.deny_probe=" + probe + "; s.child(sys.argv[1],int(sys.argv[2]))")
        self.proc = subprocess.Popen([sys.executable, "-I", "-B", "-c", bootstrap, str(config_path), str(life_fd)],
                                     stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, env=env, cwd=config_path.parent, pass_fds=(life_fd,))
        return self.proc


DUMMY = '''import argparse,hashlib,json,struct
from pathlib import Path
p=argparse.ArgumentParser()
for n in ('image','mask','parent-surface','output'):p.add_argument('--'+n)
a=p.parse_args(); out=Path(a.output)
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
glb=struct.pack('<4sII',b'glTF',2,28)+bytes(16)
(out/'object.glb').write_bytes(glb)
(out/'object.json').write_text(json.dumps({'representation':'source-photo-full-object-v1','asset':'object.glb',
'sha256':hashlib.sha256(glb).hexdigest(),'bytes':len(glb),
'initial':{'position':[0,0,-3],'quaternion':[-.5,-.5,-.5,.5],'scale':1,'modelPivot':[0,0,0]},
'model':{'id':'stabilityai/TripoSR','revision':'5b521936b01fbe1890f6f9baed0254ab6351c04a','checkpointSha256':'429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee'},
'input':{'sourceSha256':sha(a.image),'outlineSha256':sha(a.mask),'parentSurfaceSha256':sha(a.parent_surface)}}))
'''


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output, self.attempt = self.root / "output", self.root / "attempt"
        self.output.mkdir(mode=0o700)
        self.attempt.mkdir(mode=0o700)
        self.worker = self.root / "dummy.py"
        self.worker.write_text(DUMMY)
        for name in ("image", "mask", "surface"):
            (self.root / name).write_bytes(name.encode())
        self.config_path = self.attempt / "config.json"
        self.config = {"nonce": "a" * 32, "worker": str(self.worker), "workerSha256": supervisor.digest(self.worker),
                       "imagePath": str(self.root / "image"), "maskPath": str(self.root / "mask"),
                       "parentSurfacePath": str(self.root / "surface"), "outputDir": str(self.output),
                       "environment": {}, "startedEpoch": time.time()}
        self.save_config()
        self.addCleanup(self.restore_handlers)
        self.handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        self.stdout = io.StringIO()
        self.addCleanup(patch.stopall)
        patch.object(supervisor, "BASELINE", .025).start()
        patch.object(supervisor, "INTERVAL", .005).start()
        patch.object(supervisor, "hold_cleanup_unknown", side_effect=AssertionError("fixture cleanup unverified")).start()

    def restore_handlers(self):
        for sig, handler in self.handlers.items():
            signal.signal(sig, handler)

    def save_config(self):
        self.config_path.write_text(json.dumps(self.config))

    def worker_code(self, code):
        self.worker.write_text(code)
        self.config["workerSha256"] = supervisor.digest(self.worker)
        self.save_config()

    def run_supervisor(self, host=None):
        with contextlib.redirect_stdout(self.stdout):
            code = supervisor.supervise(self.config_path, host or DummyHost())
        receipt = json.loads((self.attempt / "supervisor-result.json").read_text())
        return code, receipt

    def assert_stopped(self, host):
        self.assertIsNotNone(host.proc.returncode)
        self.assertEqual(host.members(host.proc.pid), [])
        self.assertEqual(json.loads(self.stdout.getvalue().splitlines()[-1])["phase"], "stopped")

    def test_normal_dummy_baseline_identity_receipt_and_private_paths(self):
        host = DummyHost()
        original = host.sample
        host.sample = lambda output: {**original(output), "available": (2 if host.launches else 7) * supervisor.GIB,
                                      "pressure": 50, "swap_free": supervisor.GIB, "disk_free": 10 * supervisor.GIB}
        code, receipt = self.run_supervisor(host)
        self.assertEqual(code, 0)
        self.assertTrue(receipt["cleanupVerified"])
        self.assertEqual(receipt["handle"]["pgid"], host.proc.pid)
        self.assertEqual(receipt["handle"]["workerSha256"], self.config["workerSha256"])
        self.assertGreaterEqual(json.loads((self.attempt / "baseline.json").read_text())["duration"], .025)
        self.assertEqual({p.name for p in self.output.iterdir()}, {"object.glb", "object.json"})
        self.assertEqual((self.attempt / "handle.json").stat().st_mode & 0o777, 0o600)
        self.assert_stopped(host)

    def test_baseline_threshold_refuses_without_launch(self):
        host = DummyHost()
        original = host.sample
        host.sample = lambda output: {**original(output), "available": 7 * supervisor.GIB - 1}
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "baseline_threshold", 0))
        self.assertTrue(receipt["cleanupVerified"])
        diagnostic = receipt["baselineFailure"]
        self.assertEqual(diagnostic["sampleIndex"], 0)
        self.assertEqual(diagnostic["sample"], {"pressure": 75, "available": 7 * supervisor.GIB - 1,
                                               "swap_used": 0, "swap_free": 2 * supervisor.GIB,
                                               "disk_free": 20 * supervisor.GIB})
        self.assertEqual(diagnostic["failedPredicates"], [
            {"metric": "available", "operator": "<", "threshold": 7 * supervisor.GIB}])

    def test_baseline_failure_records_reached_guard_sample_predicates_and_clock_origins(self):
        host = DummyHost()
        clock = [100.0]
        safe = {"pressure": 50, "available": 7 * supervisor.GIB, "swap_used": 0,
                "swap_free": supervisor.GIB, "disk_free": 10 * supervisor.GIB}
        failing = {"pressure": 49, "available": 7 * supervisor.GIB - 1,
                   "swap_used": 64 * supervisor.MIB + 1, "swap_free": supervisor.GIB - 1,
                   "disk_free": 10 * supervisor.GIB - 1}

        def sample(_):
            host.samples += 1
            clock[0] = 100.5 if host.samples == 1 else 113.339
            return dict(safe if host.samples == 1 else failing)

        host.sample = sample
        with patch.object(supervisor, "BASELINE", 20), \
                patch.object(supervisor.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(supervisor.time, "time", return_value=self.config["startedEpoch"] + 4), \
                patch.object(supervisor.time, "sleep"), \
                patch.object(host, "launch", side_effect=AssertionError("baseline refusal must not launch")) as launch:
            code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "baseline_threshold", 0))
        launch.assert_not_called()
        self.assertEqual(receipt["failureKind"], "Stop")
        self.assertTrue(receipt["cleanupVerified"])
        self.assertIsNone(receipt["handle"])
        diagnostic = receipt["baselineFailure"]
        self.assertEqual(set(diagnostic), {"sampleIndex", "sample", "failedPredicates",
                                           "elapsedSeconds", "baselineElapsedSeconds"})
        self.assertEqual(diagnostic["sampleIndex"], 1)
        self.assertEqual(diagnostic["sample"], failing)
        self.assertEqual(diagnostic["failedPredicates"], [
            {"metric": metric, "operator": "<", "threshold": threshold}
            for metric, threshold in (("available", 7 * supervisor.GIB), ("pressure", 50),
                                      ("swap_free", supervisor.GIB), ("disk_free", 10 * supervisor.GIB))])
        self.assertAlmostEqual(diagnostic["elapsedSeconds"], 17.339)
        self.assertAlmostEqual(diagnostic["baselineElapsedSeconds"], 13.339)
        self.assertFalse((self.attempt / "baseline.json").exists())
        self.assertEqual((self.attempt / "supervisor-result.json").stat().st_mode & 0o777, 0o600)
        events = [json.loads(line) for line in self.stdout.getvalue().splitlines()]
        self.assertEqual(events, [{"nonce": self.config["nonce"], "phase": "ready"},
                                  {"nonce": self.config["nonce"], "phase": "stopped", "exitCode": 1}])

    def test_baseline_swap_range_refuses(self):
        host = DummyHost()
        original = host.sample
        host.sample = lambda output: {**original(output), "swap_used": (host.samples % 2) * (64 * supervisor.MIB + 1)}
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "baseline_swap_range", 0))
        diagnostic = receipt["baselineFailure"]
        self.assertEqual(diagnostic["sampleIndex"], 1)
        self.assertEqual(diagnostic["sample"], {"pressure": 75, "available": 8 * supervisor.GIB,
                                               "swap_used": 0, "swap_free": 2 * supervisor.GIB,
                                               "disk_free": 20 * supervisor.GIB})
        self.assertEqual(diagnostic["failedPredicates"], [{"metric": "swapUsedRangeBytes", "operator": ">",
                                                        "threshold": 64 * supervisor.MIB,
                                                        "observed": 64 * supervisor.MIB + 1,
                                                        "minimum": 0, "maximum": 64 * supervisor.MIB + 1}])

    def test_held_telemetry_times_out_before_launch(self):
        host = DummyHost()
        host.sample = lambda _: time.sleep(2)
        with patch.object(supervisor, "TELEMETRY_TIMEOUT", .02):
            code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "telemetry_timeout", 0))
        self.assertIsNone(receipt["baselineFailure"])

    def test_failed_preflight_and_launch_never_claim_success(self):
        host = DummyHost()
        host.preflight = lambda: (_ for _ in ()).throw(supervisor.Stop("synthetic_preflight_failure"))
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "synthetic_preflight_failure", 0))

    def test_launch_failure_has_safe_settlement(self):
        host = DummyHost()
        host.launch = lambda *_: (_ for _ in ()).throw(OSError("synthetic launch failure"))
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["cleanupVerified"]), (1, True))

    def test_abort_during_baseline_does_not_launch(self):
        timer = threading.Timer(.015, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.start()
        try:
            host = DummyHost()
            with patch.object(supervisor, "BASELINE", .3):
                code, receipt = self.run_supervisor(host)
            self.assertEqual((code, receipt["reason"], host.launches), (1, "aborted", 0))
        finally:
            timer.join()

    def test_abort_during_execution_kills_ignoring_worker_no_late_writes(self):
        target = self.output / "heartbeat"
        self.worker_code("import signal,time\nfrom pathlib import Path\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=Path(" + repr(str(target)) + ")\nwhile True:\n p.write_text(str(time.time()))\n time.sleep(.01)\n")
        timer = threading.Timer(.35, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.start()
        try:
            host = DummyHost()
            code, receipt = self.run_supervisor(host)
            self.assertEqual((code, receipt["reason"]), (1, "aborted"))
            self.assertEqual(host.proc.returncode, -signal.SIGKILL)
            self.assert_stopped(host)
            before = target.read_bytes()
            time.sleep(.06)
            self.assertEqual(target.read_bytes(), before)
        finally:
            timer.join()

    def test_wall_timeout_includes_baseline_and_stops_worker(self):
        self.worker_code("import time;time.sleep(10)")
        host = DummyHost()
        with patch.object(supervisor, "WALL", 2.3):
            code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "wall_limit"))
        self.assert_stopped(host)

    def test_runtime_telemetry_loss_stops_and_reaps(self):
        self.worker_code("import time;time.sleep(10)")
        host = DummyHost()
        original = host.sample
        def sample(output):
            if host.launches:
                raise OSError("synthetic sensor loss")
            return original(output)
        host.sample = sample
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "supervisor_failure"))
        self.assert_stopped(host)

    def test_missing_receipt_or_failed_worker_is_failure(self):
        self.worker_code("pass")
        host = DummyHost()
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "invalid_worker_output"))
        self.assert_stopped(host)

    def test_denial_failure_never_imports_dummy_worker(self):
        marker = self.root / "imported"
        self.worker_code("from pathlib import Path;Path(" + repr(str(marker)) + ").touch()")
        host = DummyHost(probe=False)
        code, receipt = self.run_supervisor(host)
        self.assertEqual(code, 1)
        # A fast failed bootstrap may disappear from macOS process metadata first.
        self.assertIn(receipt["reason"], ("sandbox_or_launch_failure", "supervisor_failure"))
        self.assertFalse(marker.exists())
        self.assert_stopped(host)

    def test_identity_change_closes_gate_before_worker_import(self):
        marker = self.root / "imported"
        self.worker_code("from pathlib import Path;Path(" + repr(str(marker)) + ").touch()")
        host = DummyHost()
        original = host.identity
        calls = 0
        def identity(pid):
            nonlocal calls
            calls += 1
            result = original(pid)
            if calls > 1:
                result["created"] += 1
            return result
        host.identity = identity
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "leader_identity_changed"))
        self.assertFalse(marker.exists())
        self.assert_stopped(host)

    def test_surviving_same_group_child_is_killed(self):
        target = self.output / "late-write"
        script = "import time;from pathlib import Path;time.sleep(2);Path(" + repr(str(target)) + ").touch()"
        children = self.attempt / "dummy-children.json"
        self.worker_code("import subprocess,sys,json\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-I','-B','-c'," + repr(script) + "])\nPath(" + repr(str(children)) + ").write_text(json.dumps([p.pid]))\n")
        host = DummyHost()
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "surviving_group_child"))
        self.assert_stopped(host)
        time.sleep(.06)
        self.assertFalse(target.exists())

    def test_nonempty_output_refuses_before_launch(self):
        (self.output / "existing").write_text("preserve")
        host = DummyHost()
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"], host.launches), (1, "output_or_worker_mismatch", 0))
        self.assertEqual((self.output / "existing").read_text(), "preserve")

    def test_exact_group_rss_limit_rejects_before_dummy_import(self):
        marker = self.root / "imported"
        self.worker_code("from pathlib import Path;Path(" + repr(str(marker)) + ").touch()")
        host = DummyHost()
        original = host.members
        def members(pgid):
            values = original(pgid)
            for value in values:
                value["rss"] = 4 * supervisor.GIB
            return values
        host.members = members
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "runtime_resource_limit"))
        self.assertFalse(marker.exists())
        self.assert_stopped(host)

    def test_invalid_worker_input_binding_rejects(self):
        self.worker_code(DUMMY + "p=out/'object.json'\nv=json.loads(p.read_text());v['input']['outlineSha256']='0'*64;p.write_text(json.dumps(v))\n")
        host = DummyHost()
        code, receipt = self.run_supervisor(host)
        self.assertEqual((code, receipt["reason"]), (1, "invalid_worker_receipt"))
        self.assert_stopped(host)

    def test_existing_attempt_cannot_launch_a_second_worker(self):
        class Held(Exception):
            pass
        (self.attempt / "attempt.lock").write_text("already used")
        host = DummyHost()
        with patch.object(supervisor, "hold_cleanup_unknown", side_effect=Held), self.assertRaises(Held):
            self.run_supervisor(host)
        receipt = json.loads((self.attempt / "supervisor-result.json").read_text())
        self.assertEqual((receipt["reason"], host.launches), ("attempt_already_started", 0))
        self.assertFalse(receipt["cleanupVerified"])

    def test_receipt_write_failure_is_not_success(self):
        (self.attempt / "supervisor-result.json").write_text("preserve")
        host = DummyHost()
        code = None
        with contextlib.redirect_stdout(self.stdout):
            code = supervisor.supervise(self.config_path, host)
        self.assertEqual(code, 1)
        self.assertEqual((self.attempt / "supervisor-result.json").read_text(), "preserve")
        self.assert_stopped(host)

    def test_cleanup_uncertainty_holds_instead_of_returning(self):
        class Held(Exception):
            pass
        host = DummyHost()
        real_cleanup = supervisor.cleanup
        def cleanup(proc, h):
            real_cleanup(proc, h)
            raise supervisor.Stop("synthetic_verification_loss")
        with patch.object(supervisor, "cleanup", cleanup), patch.object(supervisor, "hold_cleanup_unknown", side_effect=Held), self.assertRaises(Held):
            self.run_supervisor(host)
        receipt = json.loads((self.attempt / "supervisor-result.json").read_text())
        self.assertFalse(receipt["cleanupVerified"])
        self.assertEqual(json.loads(self.stdout.getvalue().splitlines()[-1])["phase"], "cleanup-unknown")
        self.assertIsNotNone(host.proc.returncode)


class StoredPixelTests(unittest.TestCase):
    def test_same_size_exif_2_3_4_do_not_rotate_worker_decode(self):
        from PIL import Image
        import full_object
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for orientation in (2, 3, 4):
                image = Image.new("RGB", (6, 4))
                image.putpixel((0, 0), (255, 0, 0))
                image.putpixel((5, 3), (0, 0, 255))
                exif = Image.Exif()
                exif[274] = orientation
                source = root / (str(orientation) + ".jpg")
                image.save(source, quality=100, subsampling=0, exif=exif)
                with Image.open(source) as decoded:
                    raw = decoded.convert("RGB")
                    mask = bytearray([255] * 24)
                    cutout = full_object.preprocess(decoded, mask, [0, 0, 6, 4])
                self.assertEqual(cutout.getpixel((0, 1)), raw.getpixel((0, 0)))
                self.assertEqual(cutout.getpixel((5, 4)), raw.getpixel((5, 3)))
        self.assertNotIn("torch", sys.modules)


class SupervisorDeathTests(unittest.TestCase):
    def check_death(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, attempt = root / "output", root / "attempt"
            output.mkdir(mode=0o700)
            attempt.mkdir(mode=0o700)
            for name in ("image", "mask", "surface"):
                (root / name).write_text(name)
            heartbeat = output / "heartbeat"
            childbeat = output / "child-heartbeat"
            children = attempt / "dummy-children.json"
            grandchild = "import time;from pathlib import Path;p=Path(" + repr(str(childbeat)) + ");\nwhile True:\n p.write_text(str(time.time_ns()))\n time.sleep(.01)\n"
            code = ("import time,subprocess,sys,json,ctypes\nfrom pathlib import Path\n"
                    + "c=subprocess.Popen([sys.executable,'-I','-B','-c'," + repr(grandchild) + "])\n"
                    + "Path(" + repr(str(children)) + ").write_text(json.dumps([c.pid]))\n"
                    + "p=Path(" + repr(str(heartbeat)) + ")\np.write_text(str(time.time_ns()))\n")
            if mode == "held-gil":
                code += "ctypes.PyDLL(None).sleep(20)\n"
            code += "while True:\n p.write_text(str(time.time_ns()))\n time.sleep(.01)\n"
            worker = root / "dummy.py"
            worker.write_text(code)
            config = {"nonce": "b" * 32, "worker": str(worker), "workerSha256": supervisor.digest(worker),
                      "imagePath": str(root / "image"), "maskPath": str(root / "mask"), "parentSurfacePath": str(root / "surface"),
                      "outputDir": str(output), "environment": {}, "startedEpoch": time.time()}
            config_path = attempt / "config.json"
            config_path.write_text(json.dumps(config))
            module_dir = str(Path(supervisor.__file__).parent)
            script = "import sys,os,time,json,threading;sys.path.insert(0," + repr(module_dir) + ");import full_object_supervisor as s;from test_full_object_supervisor import DummyHost\n"
            script += "s.BASELINE=.025;s.INTERVAL=.005\n"
            if mode == "startup":
                # This fixture-only hint allows independent cleanup assertions;
                # the implementation does not depend on a start receipt.
                script += ("class Early(DummyHost):\n"
                           " def launch(self,*args):\n"
                           "  p=super().launch(*args)\n"
                           "  s.save(s.Path(sys.argv[1]).parent/'fixture-pid.json',{'pid':p.pid,'created':self.psutil.Process(p.pid).create_time()})\n"
                           "  time.sleep(20)\n"
                           "  return p\n"
                           "host=Early(startup_delay=.3)\n")
            else:
                script += "host=DummyHost()\n"
            if mode == "crash":
                script += ("def crash():\n"
                           " while not (s.Path(sys.argv[1]).parent/'crash-now').exists():time.sleep(.005)\n"
                           " os._exit(77)\n"
                           "threading.Thread(target=crash,daemon=True).start()\n")
            script += "s.supervise(sys.argv[1],host)\n"
            proc = subprocess.Popen([sys.executable, "-I", "-B", "-c", script, str(config_path)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            tracked, group = {}, None
            try:
                deadline = time.monotonic() + 5
                marker = attempt / ("fixture-pid.json" if mode == "startup" else "handle.json")
                while not marker.exists() or (mode != "startup" and not (heartbeat.exists() and childbeat.exists())):
                    if proc.poll() is not None or time.monotonic() >= deadline:
                        self.fail("dummy did not reach the independently observed death boundary")
                    time.sleep(.005)
                handle = json.loads(marker.read_text())
                group = handle["pid"]
                tracked[group] = handle["created"]
                if mode == "startup":
                    self.assertFalse((attempt / "handle.json").exists())
                    self.assertFalse((attempt / "sandbox.json").exists())
                    self.assertFalse(heartbeat.exists())
                else:
                    tracked[handle["watchdog"]["pid"]] = handle["watchdog"]["created"]
                    for pid in json.loads(children.read_text()):
                        tracked[pid] = psutil.Process(pid).create_time()
                if mode == "crash":
                    (attempt / "crash-now").touch()
                else:
                    proc.kill()
                proc.wait(timeout=3)
                self.assertNotEqual(proc.returncode, 0)
                def alive(pid, created):
                    try:
                        p = psutil.Process(pid)
                        return p.create_time() == created and p.status() != psutil.STATUS_ZOMBIE
                    except psutil.NoSuchProcess:
                        return False
                deadline = time.monotonic() + 3
                while any(alive(pid, created) for pid, created in tracked.items()) and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertFalse(any(alive(pid, created) for pid, created in tracked.items()), "owned process survived supervisor loss")
                before = [p.read_bytes() if p.exists() else None for p in (heartbeat, childbeat)]
                time.sleep(.06)
                self.assertEqual([p.read_bytes() if p.exists() else None for p in (heartbeat, childbeat)], before)
                if mode == "startup":
                    self.assertEqual(before, [None, None])
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.communicate(timeout=3)
                # Only an independently identified still-live fixture member can
                # authorize this fallback cleanup; never signal a stale PGID.
                for pid, created in tracked.items():
                    try:
                        p = psutil.Process(pid)
                        if p.create_time() == created and p.status() != psutil.STATUS_ZOMBIE and os.getpgid(pid) == group:
                            os.killpg(group, signal.SIGKILL)
                            break
                    except (psutil.NoSuchProcess, ProcessLookupError):
                        pass

    def test_sigkill_supervisor_stops_worker_watchdog_and_same_group_child(self):
        self.check_death("sigkill")

    def test_supervisor_crash_stops_worker_without_finally(self):
        self.check_death("crash")

    def test_supervisor_loss_before_any_start_receipt_never_runs_producer(self):
        self.check_death("startup")

    def test_eof_watchdog_is_independent_of_a_model_process_holding_the_gil(self):
        self.check_death("held-gil")


if __name__ == "__main__":
    unittest.main()
