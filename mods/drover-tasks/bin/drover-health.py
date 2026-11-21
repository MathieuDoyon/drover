# Machine health: one JSON object on stdout, numbers or null, nothing else. python3 standard library only.
# Run by hand:  python3 drover-health.py      (or by the laptop: hc exec --on <machine> -- python3 -c "<this text>")
# Shape: {"v":1,"os":"linux|darwin|other","cores":N,"load":{"one","five","fifteen"},"loadPerCore":x,
#         "mem":{"totalMb","usedMb","pct"},"disks":{"home":{"totalMb","freeMb","pct"},"tmp":{...}}}
# A field that cannot be read is null, never a guess. No name, path or environment value is ever printed.
import json
import math
import os
import subprocess
import sys

TMP_DIR = "/tmp"  # the literal directory, not $TMPDIR
MB = 1048576


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) and x >= 0 else None


def _pct(part, whole):
    return round(100.0 * part / whole, 1) if whole else None


def parse_loadavg(text):
    try:
        p = text.split()[:3]
    except AttributeError:
        return None
    v = [_num(x) for x in p]
    if len(v) < 3 or None in v:
        return None
    return {"one": round(v[0], 2), "five": round(v[1], 2), "fifteen": round(v[2], 2)}


def _mem(total_bytes, avail_bytes):
    if total_bytes is None or avail_bytes is None or total_bytes <= 0:
        return None
    used = max(0.0, total_bytes - avail_bytes)
    return {"totalMb": int(round(total_bytes / MB)), "usedMb": int(round(used / MB)), "pct": min(100.0, _pct(used, total_bytes))}


def parse_meminfo(text):
    kb = {}
    try:
        lines = text.splitlines()
    except AttributeError:
        return None
    for line in lines:
        k, _, rest = line.partition(":")
        w = rest.split()
        if w and k in ("MemTotal", "MemAvailable"):
            kb[k] = _num(w[0])
    t, a = kb.get("MemTotal"), kb.get("MemAvailable")
    return _mem(None if t is None else t * 1024, None if a is None else a * 1024)


def parse_vm_stat(text, memsize):
    try:
        lines = text.splitlines()
        total = _num(memsize.strip())
        head = lines[0]
        a = head.index("page size of ") + len("page size of ")
        page = _num(head[a:].split()[0])
    except (AttributeError, ValueError, IndexError):
        return None
    if not page or not total:
        return None
    pages = {}
    for line in lines[1:]:
        k, _, rest = line.partition(":")
        w = rest.strip().rstrip(".")
        if k in ("Pages free", "Pages inactive", "Pages speculative"):
            pages[k] = _num(w)
    if len(pages) < 3 or None in pages.values():
        return None
    return _mem(total, sum(pages.values()) * page)


def _disk(usage, path):
    try:
        total, free = usage(path)
    except (OSError, ValueError, TypeError):
        return None
    if not total or total <= 0 or free < 0:
        return None
    return {"totalMb": int(total // MB), "freeMb": int(free // MB), "pct": _pct(total - free, total)}


def _read(path):
    with open(path, "r") as f:
        return f.read()


def _run(argv):
    r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, universal_newlines=True)
    if r.returncode != 0:
        raise OSError("exit")
    return r.stdout


def _du(path):
    u = os.statvfs(path)
    return u.f_frsize * u.f_blocks, u.f_frsize * u.f_bavail


def sample(plat, read_file=_read, sysctl=None, vm_stat=None, getloadavg=os.getloadavg, cpu_count=os.cpu_count, disk_usage=_du, home=None):
    sysctl = sysctl or (lambda name: _run(["sysctl", "-n", name]))
    vm_stat = vm_stat or (lambda: _run(["vm_stat"]))

    def safe(fn, *a):
        try:
            return fn(*a)
        except Exception:
            return None

    kind = "linux" if plat.startswith("linux") else "darwin" if plat == "darwin" else "other"
    cores = safe(cpu_count)
    cores = cores if isinstance(cores, int) and cores > 0 else None
    if kind == "linux":
        load = parse_loadavg(safe(read_file, "/proc/loadavg"))
        mem = parse_meminfo(safe(read_file, "/proc/meminfo"))
    else:
        la = safe(getloadavg)
        load = parse_loadavg(" ".join(str(x) for x in la)) if la else None
        mem = parse_vm_stat(safe(vm_stat), safe(sysctl, "hw.memsize")) if kind == "darwin" else None
    return {
        "v": 1,
        "os": kind,
        "cores": cores,
        "load": load,
        "loadPerCore": round(load["one"] / cores, 2) if load and cores else None,
        "mem": mem,
        "disks": {"home": _disk(disk_usage, home) if home else None, "tmp": _disk(disk_usage, TMP_DIR)},
    }


def main():
    try:
        out = json.dumps(sample(sys.platform, home=os.path.expanduser("~")), separators=(",", ":"), allow_nan=False)
    except BaseException:
        sys.exit(1)
    sys.stdout.write(out + "\n")


if __name__ == "__main__":
    main()
