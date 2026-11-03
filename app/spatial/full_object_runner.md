# Supervised offline object worker

The runner is a separate, fail-closed adapter for the full-object worker.
It is not enabled by importing it and does not authorize inference. Keep the
backend runner unset until the deployed code, controls and runtime have been
independently reviewed and the execution explicitly admitted.

`full_object_runner.mjs` exports
`createFullObjectRunner({pythonPath, workerPath, workerSha256, attemptRoot,
environment, onCleanupUncertain})`. `pythonPath`, `workerPath` and `attemptRoot` are absolute;
`workerSha256` pins the reviewed producer bytes. `attemptRoot` is a protected
directory owned by the current user, separate from all output directories.
`environment` accepts only the three `FULL_OBJECT_*` model/source paths and
the documented cache/temp path names; secrets and account settings are not
configuration. Each attempt overrides cache/temp paths with its own protected
directories. No runtime or model installation is performed.

The factory returns the backend seam:

```js
runFullObject({imagePath, maskPath, parentSurfacePath, outputDir, signal})
// Promise<{exitCode:number}>
```

The caller provides immutable, source-bound inputs and an existing empty
0700 output directory. Only the producer's `object.glb` and `object.json`
belong there. Logs, config, baseline, start identity, sandbox proof and
supervisor result are kept in a separate 0700 attempt directory with 0600
files. Private diagnostics must never become public error responses.
The supervisor hashes inputs and producer before execution and again before
accepting output. The backend remains responsible for full GLB validation,
independently recomputed pose, permissions and atomic publication.

`full_object_supervisor.py` adapts the sampled CPU supervision policy. It
supports macOS with the existing `sandbox-exec` command and a provisioned
Python environment containing psutil. Unsupported or denied host inspection
fails before producer import. The startup clock includes adapter dispatch,
baseline, imports, loading, forward and extraction in the 600-second budget;
shutdown starts two seconds before its deadline. Cleanup is still awaited if
it takes longer: reaching a timeout never proves that the group stopped.

The fresh baseline lasts at least 20 seconds. Every sample requires available
memory >=7 GiB, system free-memory percentage >=50, free swap >=1 GiB and
free disk >=10 GiB; the baseline swap range must be <=64 MiB. Runtime samples
require whole worker-group RSS <4 GiB, global swap growth from the last
baseline sample <256 MiB and available memory >=2 GiB. The normal sampling
interval is 0.5 seconds. Telemetry operations have a five-second alarm and
external-command timeout. Failure, missing data, a foreign-UID group member,
identity change or parent cancellation stops the attempt. No limit is retried
or relaxed. These are sampled limits, not OS hard memory limits; transient
peaks and detached descendants can escape observation.

The actual worker group starts behind an import gate inside the fixed
OS sandbox profile `(version 1)(allow default)(deny network*)`. Its stdlib-only
bootstrap checks that loopback TCP connect and UDP bind both fail specifically
with access denied. A timeout, refused connection or successful operation is
not proof. The parent checks and persists PID, PGID, creation time, nonce and
producer hash, verifies the child's proof, then releases one stdin token.
Offline environment flags alone never substitute for this OS check.

Before the sandbox proof or producer import, the stdlib-only worker bootstrap
forks a dedicated EOF watchdog in its own group and waits for readiness. A
separate pipe has exactly one intended writer, the supervisor; only its read
end reaches the worker/watchdog. The writer is non-inheritable and subprocesses
close unrelated descriptors. Supervisor SIGKILL or crash closes that writer
in the kernel. The watchdog then kills its own group, including itself; its
live membership keeps the group identity reserved. This does not depend on
Python cleanup, receipts, a signal to a dead supervisor, or the model's GIL.
If the supervisor disappears before the watchdog starts, the bootstrap's
closed-pipe checks prevent reaching the producer. Before releasing import,
the supervisor binds watchdog PID, PGID and creation time into its handle;
it also checks watchdog liveness while running. Cleanup closes the writer
before normal escalation. The same unchanged RSS limit includes the watchdog.
This is POSIX process/descriptor containment for the admitted macOS path,
not a universal OS job-control guarantee or detached-process containment.
The frozen producer separately enforces local code/model pins, CPU FP32,
four intra-op/one inter-op threads, safe weights-only loading, one guarded
forward and chunk8192/resolution256.

Cancellation before readiness is remembered. After readiness the adapter
signals the supervisor, whose handlers remain active during baseline and
cleanup. The supervisor sends TERM then KILL to its session-created group
before polling or reaping its leader; the unreaped PID prevents group-ID
reuse during escalation. It then reaps the leader and independently verifies
an empty group. Signal errors are recorded even if later empty-group
verification establishes safe cleanup. A surviving same-group child makes
the attempt fail and is included in cleanup. A successful leader exit alone
is insufficient.

The Promise settles only after the supervisor reports verified cleanup and
closes. A valid success additionally requires a matching protected result,
output hashes and producer hash. Invalid or missing receipts, nonzero exit
or an aborted signal return failure after safe cleanup. Unverified cleanup,
unexpected supervisor death or an invalid control stream invokes the private
`onCleanupUncertain({attemptDirectory, reason})` callback once and deliberately
leaves the Promise pending. The backend must keep that operation active and
surface an operational intervention requirement; it must not delete the
attempt, publish output or start a replacement worker. The callback is not a
public error DTO. An exclusive attempt lock prevents reusing an attempt.

Run focused synthetic checks from the repository root:

```sh
python -B -m unittest discover -s app/spatial -p test_full_object_supervisor.py
node --test app/spatial/full_object_runner.test.mjs
python3 tools/check-repository.py
git diff --check
```

Python tests use real dummy processes with synthetic resources and only
fixture-declared process IDs. They exercise TERM/KILL, reaping, cancellation,
timeout, surviving children, identity checks, cleanup uncertainty and absence
of late writes. The sandbox proof is explicitly mocked there. JS tests use a
dummy interpreter implementing the private control protocol. Neither suite
loads a model or establishes real-host network/resource admission. The
additional JPEG checks cover stored-order EXIF orientations 2/3/4 only; PNG is
the initial native fixture, with no universal EXIF compatibility claim.
Abrupt-death regressions additionally kill/crash the supervisor while a dummy
and its same-group child write, kill it before any production start receipt,
and hold the dummy's GIL in a C call. They verify stopped identities and no
late writes. An unexpected supervisor death still retains the backend slot:
watchdog containment does not invent independent cleanup verification.
