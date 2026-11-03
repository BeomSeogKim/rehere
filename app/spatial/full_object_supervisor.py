"""A fail-closed macOS supervisor; importing this module never imports a model."""
import contextlib
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

sys.dont_write_bytecode = True
GIB, MIB = 1024**3, 1024**2
WALL, BASELINE, INTERVAL, TELEMETRY_TIMEOUT = 600, 20, .5, 5
PROFILE = "(version 1)(allow default)(deny network*)"
ENV_KEYS = {"FULL_OBJECT_TRIPOSR_SOURCE", "FULL_OBJECT_MODEL_DIR", "FULL_OBJECT_DINO_CONFIG",
            "HF_HOME", "HF_HUB_CACHE", "XDG_CACHE_HOME", "NUMBA_CACHE_DIR", "TMPDIR"}
MODEL = {"id": "stabilityai/TripoSR", "revision": "5b521936b01fbe1890f6f9baed0254ab6351c04a",
         "checkpointSha256": "429e2c6b22a0923967459de24d67f05962b235f79cde6b032aa7ed2ffcd970ee"}


class Stop(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(MIB), b""):
            h.update(block)
    return h.hexdigest()


def save(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())


def private_directory(path):
    info = Path(path).lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Stop("unsafe_directory")


def read_config(path):
    path = Path(path)
    private_directory(path.parent)
    if path.is_symlink() or path.stat().st_size > 32768:
        raise Stop("invalid_config")
    config = json.loads(path.read_text())
    if set(config) != {"nonce", "worker", "workerSha256", "imagePath", "maskPath", "parentSurfacePath", "outputDir", "environment", "startedEpoch"}:
        raise Stop("invalid_config")
    if (not re.fullmatch(r"[0-9a-f]{32}", config["nonce"])
            or not re.fullmatch(r"[0-9a-f]{64}", config["workerSha256"])
            or type(config["startedEpoch"]) not in (int, float) or not math.isfinite(config["startedEpoch"])
            or not isinstance(config["environment"], dict) or not set(config["environment"]) <= ENV_KEYS):
        raise Stop("invalid_config")
    for key in ("worker", "imagePath", "maskPath", "parentSurfacePath", "outputDir"):
        if not isinstance(config[key], str) or not Path(config[key]).is_absolute() or "\0" in config[key]:
            raise Stop("invalid_path")
    if any(not isinstance(v, str) or "\0" in v for v in config["environment"].values()):
        raise Stop("invalid_environment")
    return config


@contextlib.contextmanager
def bounded(seconds=TELEMETRY_TIMEOUT):
    def expired(*_):
        raise Stop("telemetry_timeout")
    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(.001, seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


class Host:
    def preflight(self):
        if sys.platform != "darwin" or not os.access("/usr/bin/sandbox-exec", os.X_OK):
            raise Stop("os_network_control_unavailable")
        try:
            import psutil
        except ImportError:
            raise Stop("telemetry_unavailable") from None
        self.psutil = psutil
        self.members(os.getpgrp())
        psutil.Process(os.getpid()).create_time()

    def sample(self, output):
        swap, memory = self.psutil.swap_memory(), self.psutil.virtual_memory()
        result = subprocess.run(["/usr/bin/memory_pressure", "-Q"], capture_output=True,
                                text=True, check=True, timeout=TELEMETRY_TIMEOUT)
        match = re.search(r"System-wide memory free percentage:\s*(\d+)%", result.stdout)
        if not match:
            raise Stop("pressure_unavailable")
        sample = {"pressure": int(match[1]), "available": memory.available, "swap_used": swap.used,
                  "swap_free": swap.free, "disk_free": shutil.disk_usage(output).free}
        if any(type(v) is not int or v < 0 for v in sample.values()) or sample["pressure"] > 100:
            raise Stop("invalid_telemetry")
        return sample

    def members(self, pgid):
        result = subprocess.run(["/bin/ps", "-axo", "pid=,pgid=,rss=,uid="], capture_output=True,
                                text=True, check=True, timeout=TELEMETRY_TIMEOUT)
        members = []
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) != 4:
                raise Stop("group_telemetry_unavailable")
            pid, group, rss, uid = map(int, fields)
            if pid <= 0 or group <= 0 or rss < 0 or uid < 0:
                raise Stop("invalid_group_telemetry")
            if group == pgid:
                members.append({"pid": pid, "rss": rss * 1024, "uid": uid})
        return members

    def identity(self, pid):
        process = self.psutil.Process(pid)
        created = process.create_time()
        zombie = process.status() == self.psutil.STATUS_ZOMBIE
        try:
            pgid = os.getpgid(pid)
        except (ProcessLookupError, PermissionError):
            zombie = process.status() == self.psutil.STATUS_ZOMBIE
            if not zombie:
                raise
            pgid = pid
        return {"pgid": pgid, "created": created, "zombie": zombie}

    def launch(self, config_path, log, env, life_fd):
        return subprocess.Popen(["/usr/bin/nice", "-n", "10", "/usr/bin/sandbox-exec", "-p", PROFILE,
                                 sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--child", str(config_path), str(life_fd)],
                                stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT,
                                cwd=config_path.parent, env=env, start_new_session=True, pass_fds=(life_fd,))


def deny_probe():
    # Loopback only: both operations succeed or refuse differently without OS denial.
    for kind, operation in ((socket.SOCK_STREAM, "connect"), (socket.SOCK_DGRAM, "bind")):
        try:
            with socket.socket(socket.AF_INET, kind) as channel:
                channel.settimeout(1)
                if operation == "connect":
                    channel.connect(("127.0.0.1", 9))
                else:
                    channel.bind(("127.0.0.1", 0))
        except OSError as error:
            if error.errno in (errno.EPERM, errno.EACCES):
                continue
        raise Stop("os_network_denial_not_established")


def require_live_parent(life_fd):
    if select.select([life_fd], [], [], 0)[0]:
        # This caller is the owned group leader, or its in-group watchdog.
        os.killpg(os.getpgrp(), signal.SIGKILL)
        os._exit(1)


def parent_watchdog(life_fd):
    group = os.getpgrp()
    if group != os.getpid():
        raise Stop("worker_group_unverified")
    require_live_parent(life_fd)
    ready_read, ready_write = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(ready_read)
        try:
            if os.getpgrp() != group:
                os._exit(1)
            require_live_parent(life_fd)
            os.write(ready_write, b"R")
            os.close(ready_write)
            # Only the supervisor owns a writer. SIGKILL/crash closes it in the
            # kernel; this separate process does not depend on the model's GIL.
            os.read(life_fd, 1)
            os.killpg(os.getpgrp(), signal.SIGKILL)
        finally:
            os._exit(1)
    os.close(ready_write)
    try:
        if os.read(ready_read, 1) != b"R":
            raise Stop("watchdog_not_ready")
    finally:
        os.close(ready_read)
    require_live_parent(life_fd)
    return pid


def child(config_path, life_fd):
    if os.getpgrp() != os.getpid():
        raise Stop("worker_group_unverified")
    require_live_parent(life_fd)
    config = read_config(config_path)
    watchdog_pid = parent_watchdog(life_fd)
    deny_probe()
    attempt = Path(config_path).parent
    save(attempt / "sandbox.json", {"nonce": config["nonce"], "pid": os.getpid(), "pgid": os.getpgrp(),
                                    "networkDenied": True, "watchdogPid": watchdog_pid})
    # No producer import until the parent persists the independently checked identity.
    if sys.stdin.buffer.readline(128) != (config["nonce"] + "\n").encode():
        raise Stop("launch_gate_closed")
    if digest(config["worker"]) != config["workerSha256"]:
        raise Stop("worker_changed")
    require_live_parent(life_fd)
    os.set_inheritable(life_fd, False)
    sys.path.insert(0, str(Path(config["worker"]).parent))
    sys.argv = [config["worker"], "--image", config["imagePath"], "--mask", config["maskPath"],
                "--parent-surface", config["parentSurfacePath"], "--output", config["outputDir"]]
    runpy.run_path(config["worker"], run_name="__main__")


def output_receipt(config, inputs):
    output = Path(config["outputDir"])
    if {p.name for p in output.iterdir()} != {"object.glb", "object.json"}:
        raise Stop("invalid_worker_output")
    asset, path = output / "object.glb", output / "object.json"
    if asset.is_symlink() or path.is_symlink() or path.stat().st_size > 65536 or not 28 <= asset.stat().st_size <= 128 * MIB:
        raise Stop("invalid_worker_output")
    value = json.loads(path.read_text())
    with asset.open("rb") as stream:
        header = stream.read(12)
    if (struct.unpack("<4sII", header) != (b"glTF", 2, asset.stat().st_size)
            or set(value) != {"representation", "asset", "sha256", "bytes", "initial", "model", "input"}
            or value["representation"] != "source-photo-full-object-v1" or value["asset"] != "object.glb"
            or value["sha256"] != digest(asset) or type(value["bytes"]) is not int
            or value["bytes"] != asset.stat().st_size or value["input"] != inputs
            or not isinstance(value["initial"], dict) or value["model"] != MODEL):
        raise Stop("invalid_worker_receipt")
    pose = value["initial"]
    if (set(pose) != {"position", "quaternion", "scale", "modelPivot"} or pose["quaternion"] != [-.5, -.5, -.5, .5]
            or type(pose["scale"]) not in (int, float) or not math.isfinite(pose["scale"]) or not .05 <= pose["scale"] <= 5):
        raise Stop("invalid_worker_pose")
    for key in ("position", "modelPivot"):
        if (not isinstance(pose[key], list) or len(pose[key]) != 3
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in pose[key])):
            raise Stop("invalid_worker_pose")
    if any(abs(v) > 10 for v in pose["position"]):
        raise Stop("invalid_worker_pose")
    return {"assetSha256": value["sha256"], "receiptSha256": digest(path), "bytes": value["bytes"]}


def cleanup(proc, host):
    # No poll/wait before escalation: the unreaped PID reserves our group identity.
    try:
        if os.getpgid(proc.pid) != proc.pid:
            raise Stop("cleanup_identity_mismatch")
    except ProcessLookupError:
        pass
    errors = []
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            errors.append(signal.Signals(sig).name)
        if sig == signal.SIGTERM:
            time.sleep(1)
    if proc.stdin is not None:
        proc.stdin.close()
    proc.wait(timeout=5)
    deadline = time.monotonic() + 2
    while True:
        with bounded():
            members = host.members(proc.pid)
        if not members:
            return {"verified": True, "groupEmpty": True, "reaped": True, "signalErrors": errors}
        if time.monotonic() >= deadline:
            raise Stop("cleanup_unverified")
        time.sleep(.1)


def hold_cleanup_unknown():
    while True:
        time.sleep(1)


def supervise(config_path, host=None):
    config_path = Path(config_path)
    config = read_config(config_path)
    host = host or Host()
    attempt, output = config_path.parent, Path(config["outputDir"])
    started = time.monotonic()
    elapsed_before_start = max(0, time.time() - config["startedEpoch"])
    deadline = started + WALL - elapsed_before_start
    aborted = False

    def abort(*_):
        nonlocal aborted
        aborted = True

    handlers = {sig: signal.signal(sig, abort) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    print(json.dumps({"nonce": config["nonce"], "phase": "ready"}), flush=True)
    proc, reason, handle, baseline, proof, result = None, None, None, [], None, None
    life_read, life_write, watchdog = None, None, None
    failure_kind = None
    baseline_failure = None
    verified, peak_rss, peak_swap, cleanup_result = True, 0, 0, None

    def check():
        if aborted:
            raise Stop("aborted")
        if time.monotonic() >= deadline - 2:
            raise Stop("wall_limit")

    def telemetry(call):
        check()
        with bounded(min(TELEMETRY_TIMEOUT, max(.001, deadline - time.monotonic() - 2))):
            result = call()
        check()
        return result

    def baseline_diagnostic(sample, predicates):
        failed_at = time.monotonic()
        return {"sampleIndex": len(baseline) - 1,
                "sample": {key: sample[key] for key in ("pressure", "available", "swap_used", "swap_free", "disk_free")},
                "failedPredicates": predicates,
                "elapsedSeconds": failed_at - started + elapsed_before_start,
                "baselineElapsedSeconds": failed_at - baseline_start}

    try:
        check()
        if (attempt / "attempt.lock").exists():
            verified = False
            raise Stop("attempt_already_started")
        save(attempt / "attempt.lock", {"nonce": config["nonce"], "supervisorPid": os.getpid()})
        private_directory(output)
        if any(output.iterdir()) or digest(config["worker"]) != config["workerSha256"]:
            raise Stop("output_or_worker_mismatch")
        inputs = {key: digest(config[name]) for key, name in (("sourceSha256", "imagePath"), ("outlineSha256", "maskPath"), ("parentSurfaceSha256", "parentSurfacePath"))}
        telemetry(host.preflight)
        baseline_start = time.monotonic()
        while True:
            sample = telemetry(lambda: host.sample(output))
            baseline.append(sample)
            if (sample["available"] < 7 * GIB or sample["pressure"] < 50 or sample["swap_free"] < GIB
                    or sample["disk_free"] < 10 * GIB):
                baseline_failure = baseline_diagnostic(sample, [
                    {"metric": metric, "operator": "<", "threshold": threshold}
                    for metric, threshold in (("available", 7 * GIB), ("pressure", 50),
                                              ("swap_free", GIB), ("disk_free", 10 * GIB))
                    if sample[metric] < threshold])
                raise Stop("baseline_threshold")
            if max(s["swap_used"] for s in baseline) - min(s["swap_used"] for s in baseline) > 64 * MIB:
                minimum, maximum = min(s["swap_used"] for s in baseline), max(s["swap_used"] for s in baseline)
                baseline_failure = baseline_diagnostic(sample, [
                    {"metric": "swapUsedRangeBytes", "operator": ">", "threshold": 64 * MIB,
                     "observed": maximum - minimum, "minimum": minimum, "maximum": maximum}])
                raise Stop("baseline_swap_range")
            if time.monotonic() - baseline_start >= BASELINE:
                break
            time.sleep(min(1, INTERVAL))
        save(attempt / "baseline.json", {"duration": time.monotonic() - baseline_start, "samples": baseline})
        check()
        env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONHOME", "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"}}
        env.update(config["environment"])
        for name in ("cache", "tmp", "hf-home"):
            (attempt / name).mkdir(mode=0o700)
        env.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                    "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
                    "HF_HOME": str(attempt / "hf-home"), "HF_HUB_CACHE": str(attempt / "hf-home" / "hub"),
                    "XDG_CACHE_HOME": str(attempt / "cache"), "NUMBA_CACHE_DIR": str(attempt / "cache"), "TMPDIR": str(attempt / "tmp")})
        log_fd = os.open(attempt / "worker.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(log_fd, "wb") as log:
            life_read, life_write = os.pipe()
            try:
                proc = host.launch(config_path, log, env, life_read)
            finally:
                os.close(life_read)
                life_read = None
            verified = False
            identity = telemetry(lambda: host.identity(proc.pid))
            if identity["pgid"] != proc.pid:
                raise Stop("launch_identity_mismatch")
            handle = {"nonce": config["nonce"], "pid": proc.pid, "pgid": proc.pid, "created": identity["created"],
                      "supervisorPid": os.getpid(), "workerSha256": config["workerSha256"]}
            gate_open = False
            while True:
                identity = telemetry(lambda: host.identity(proc.pid))
                if identity["pgid"] != proc.pid or identity["created"] != handle["created"]:
                    raise Stop("leader_identity_changed")
                members = telemetry(lambda: host.members(proc.pid))
                if ((not members and not identity["zombie"])
                        or any(m["uid"] != os.getuid() for m in members)):
                    raise Stop("group_ownership_unverified")
                sample = telemetry(lambda: host.sample(output))
                rss, swap = sum(m["rss"] for m in members), sample["swap_used"] - baseline[-1]["swap_used"]
                peak_rss, peak_swap = max(peak_rss, rss), max(peak_swap, swap)
                if rss >= 4 * GIB or swap >= 256 * MIB or sample["available"] < 2 * GIB:
                    raise Stop("runtime_resource_limit")
                if identity["zombie"]:
                    if not gate_open:
                        raise Stop("sandbox_or_launch_failure")
                    if any(m["pid"] not in (proc.pid, watchdog["pid"]) for m in members):
                        raise Stop("surviving_group_child")
                    break
                sandbox = attempt / "sandbox.json"
                if not gate_open and sandbox.exists():
                    if sandbox.is_symlink() or sandbox.stat().st_size > 1024:
                        raise Stop("invalid_sandbox_proof")
                    proof = json.loads(sandbox.read_text())
                    watchdog_pid = proof.get("watchdogPid")
                    if (type(watchdog_pid) is not int or watchdog_pid <= 0 or watchdog_pid == proc.pid
                            or proof != {"nonce": config["nonce"], "pid": proc.pid, "pgid": proc.pid,
                                         "networkDenied": True, "watchdogPid": watchdog_pid}):
                        raise Stop("invalid_sandbox_proof")
                    watched = telemetry(lambda: host.identity(watchdog_pid))
                    if watched["pgid"] != proc.pid or watched["zombie"]:
                        raise Stop("watchdog_unverified")
                    watchdog = {"pid": watchdog_pid, "pgid": watched["pgid"], "created": watched["created"]}
                    handle["watchdog"] = watchdog
                    save(attempt / "handle.json", handle)
                    check()
                    proc.stdin.write((config["nonce"] + "\n").encode())
                    proc.stdin.flush()
                    proc.stdin.close()
                    gate_open = True
                if gate_open:
                    watched = telemetry(lambda: host.identity(watchdog["pid"]))
                    if watched["pgid"] != proc.pid or watched["created"] != watchdog["created"] or watched["zombie"]:
                        raise Stop("watchdog_lost")
                time.sleep(INTERVAL)
    except BaseException as error:
        reason = str(error) if isinstance(error, Stop) else "supervisor_failure"
        failure_kind = type(error).__name__
    finally:
        if life_write is not None:
            os.close(life_write)
            life_write = None
        if proc is not None:
            try:
                cleanup_result = cleanup(proc, host)
                verified = cleanup_result["verified"]
            except BaseException:
                verified = False
                reason = reason or "cleanup_unverified"
    if aborted:
        reason = reason or "aborted"
    if not reason and (proc is None or proc.returncode != 0):
        reason = "worker_failed"
    if not reason and verified:
        try:
            check()
            result = output_receipt(config, inputs)
            if digest(config["worker"]) != config["workerSha256"] or any(digest(config[name]) != inputs[key] for key, name in
                    (("sourceSha256", "imagePath"), ("outlineSha256", "maskPath"), ("parentSurfaceSha256", "parentSurfacePath"))):
                raise Stop("input_changed")
        except BaseException as error:
            reason = str(error) if isinstance(error, Stop) else "invalid_worker_receipt"
    receipt = {"nonce": config["nonce"], "status": "complete" if not reason and verified else "failed",
               "reason": reason, "cleanupVerified": verified, "handle": handle, "networkProof": proof,
               "failureKind": failure_kind,
               "baselineFailure": baseline_failure,
               "cleanup": cleanup_result,
               "workerExitCode": None if proc is None else proc.returncode, "result": result,
               "sampled": {"elapsedSeconds": time.monotonic() - started + elapsed_before_start,
                           "peakGroupRssBytes": peak_rss, "peakGlobalSwapGrowthBytes": peak_swap, "intervalSeconds": INTERVAL},
               "limits": "Sampled limits; transient peaks and detached descendants may escape observation."}
    try:
        save(attempt / "supervisor-result.json", receipt)
    except BaseException:
        reason = reason or "receipt_write_failed"
        receipt["status"], receipt["reason"] = "failed", reason
    event = {"nonce": config["nonce"], "phase": "stopped" if verified else "cleanup-unknown",
             "exitCode": 0 if not reason and verified else 1}
    print(json.dumps(event), flush=True)
    if not verified:
        # Keeping this process and its backend Promise active is deliberate.
        hold_cleanup_unknown()
    for sig, old in handlers.items():
        signal.signal(sig, old)
    return event["exitCode"]


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--child":
            child(sys.argv[2], int(sys.argv[3]))
        elif len(sys.argv) == 2:
            raise SystemExit(supervise(sys.argv[1]))
        else:
            raise Stop("invalid_arguments")
    except Exception:
        print("The supervised object worker could not start.", file=sys.stderr)
        raise SystemExit(1)
