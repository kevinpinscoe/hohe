#!/usr/bin/env python3
"""Import open Todoist tasks into HOHE (POE-74, HOHE Phase 5).

Three subcommands, standard library only:

  fetch  Read-only Todoist snapshot (Sync API v1) into a new file, mode 0600. The token comes
         from a curl config named by $TODOIST_CURL_CONFIG, which the Parzival profile
         `todoist-curl` provides; the token never appears on a command line.
  plan   Dry run. Reads a snapshot and a split file and writes the reconciliation report
         (JSON and Markdown). It makes no network calls.
  apply  Logs in to HOHE with the password in the file named by $HOHE_LOGIN_PASSWORD_FILE
         (Parzival profile `hohe-login`), skips every task already imported, imports the rest
         through /api/sync, then re-reads HOHE and checks every planned task is present.

Mapping (Kevin, 2026-11-08):
  - Only tasks in projects listed under "hohe" in the split file are imported. Projects under
    "donetick" or "exclude" are reported as excluded, with their reason. A project in the
    snapshot that the split file does not list stops the run, so nothing is skipped silently.
  - Every task arrives with no priority letter and no day, in the Task Dump, for one fresh
    triage. Todoist priorities are kept in the notes for reference.
  - The HOHE task id is "todoist-<Todoist id>". HOHE refuses a reused id, and apply skips ids
    that already exist, so a rerun never duplicates and never overwrites a task edited in HOHE.
  - Tags: "todoist", the project name and the section name, if any, slugged.
  - Notes: the Todoist description, then the comments, then a provenance footer.
  - Sub-tasks are flattened. Parent and children are tagged "review", and their notes name
    each other, so the lost nesting can be checked.

Completed and deleted Todoist tasks are never imported.
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SYNC_URL = "https://api.todoist.com/api/v1/sync"
RESOURCE_TYPES = ["items", "projects", "sections", "labels", "notes", "project_notes", "filters", "reminders"]
DEVICE_ID = "todoist-import"
CLIENT_HEADER = "X-HOHE-Client"
MAX_TITLE = 500
MAX_NOTES = 20000
MAX_TAGS = 20
MAX_TAG = 50
BATCH_TASKS = 40  # tasks per /api/sync call (3 ops each); far below the 2 MiB body limit


# ── helpers ─────────────────────────────────────────────────────────────────────────────

def die(msg: str, code: int = 1) -> None:
    print(f"todoist-import: {msg}", file=sys.stderr)
    sys.exit(code)


def slug(s: str) -> str:
    s = re.sub(r"[^\w]+", "-", s.lower(), flags=re.UNICODE).strip("-")
    s = re.sub(r"-+", "-", s)
    return (s or "untitled")[:MAX_TAG]


def write_private(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ── the plan: pure, no I/O, unit-tested ─────────────────────────────────────────────────

def build_plan(snap: dict, split: dict, today: str) -> dict:
    """Classify every open task and build the HOHE payload for those to import."""
    projects = {p["id"]: p for p in snap.get("projects", [])}
    sections = {s["id"]: s for s in snap.get("sections", [])}
    items = [i for i in snap.get("items", []) if not i.get("is_deleted")]
    open_items = [i for i in items if not i.get("checked")]
    by_id = {i["id"]: i for i in open_items}
    comments: dict[str, list] = {}
    for n in snap.get("notes", []):
        if not n.get("is_deleted") and n.get("item_id") in by_id:
            comments.setdefault(n["item_id"], []).append(n)

    hohe = set(split.get("hohe", []))
    donetick = set(split.get("donetick", []))
    exclude = dict(split.get("exclude", {}))
    overlap = (hohe & donetick) | (hohe & set(exclude)) | (donetick & set(exclude))
    if overlap:
        raise ValueError(f"projects listed twice in the split file: {sorted(overlap)}")
    used = {projects[i["project_id"]]["name"] for i in open_items if i["project_id"] in projects}
    unlisted = sorted(used - hohe - donetick - set(exclude))
    if unlisted:
        raise ValueError(f"projects not in the split file (classify them first): {unlisted}")
    if any(i["project_id"] not in projects for i in open_items):
        raise ValueError("a task names a project missing from the snapshot")

    children: dict[str, list] = {}
    for i in open_items:
        if i.get("parent_id"):
            children.setdefault(i["parent_id"], []).append(i)

    entries = []
    for i in sorted(open_items, key=lambda x: (projects[x["project_id"]]["name"], x.get("child_order", 0), x["id"])):
        pname = projects[i["project_id"]]["name"]
        sec = sections.get(i.get("section_id") or "")
        e = {"todoist_id": i["id"], "project": pname, "section": sec["name"] if sec else "",
             "title": i.get("content", ""), "todoist_priority": i.get("priority", 1)}
        if pname in donetick:
            e.update(outcome="excluded", reason="list-type project: moves to Donetick (POE-79)")
        elif pname in exclude:
            e.update(outcome="excluded", reason=exclude[pname])
        else:
            e.update(outcome="import", hohe=hohe_task(i, pname, e["section"], comments.get(i["id"], []),
                                                      by_id.get(i.get("parent_id") or ""),
                                                      children.get(i["id"], []), today))
            if e["hohe"]["review"]:
                e["outcome"] = "import-review"
        entries.append(e)

    counts = {"source_open": len(open_items),
              "import": sum(e["outcome"] == "import" for e in entries),
              "import_review": sum(e["outcome"] == "import-review" for e in entries),
              "excluded": sum(e["outcome"] == "excluded" for e in entries)}
    counts["balanced"] = counts["import"] + counts["import_review"] + counts["excluded"] == counts["source_open"]
    by_reason: dict[str, int] = {}
    for e in entries:
        if e["outcome"] == "excluded":
            by_reason[e["reason"]] = by_reason.get(e["reason"], 0) + 1
    return {"format": "hohe-todoist-import-plan/1", "planned_at": today, "counts": counts,
            "excluded_by_reason": by_reason, "entries": entries}


def hohe_task(item: dict, project: str, section: str, notes: list, parent: dict | None,
              kids: list, today: str) -> dict:
    review = []
    title = item.get("content", "").strip() or "(untitled Todoist task)"
    if len(title.encode()) > MAX_TITLE:
        review.append("title shortened to 500 bytes; full title in notes")
    parts = []
    if (item.get("description") or "").strip():
        parts.append(item["description"].strip())
    for n in sorted(notes, key=lambda n: n.get("posted_at", "")):
        when = (n.get("posted_at") or "")[:10]
        parts.append(f"Todoist comment {when}: {n.get('content', '').strip()}")
    if parent:
        review.append("was a Todoist sub-task")
        parts.append(f"Todoist sub-task of: {parent.get('content', '').strip()} (now todoist-{parent['id']})")
    if kids:
        review.append("had Todoist sub-tasks")
        parts.append("Todoist sub-tasks (imported separately): " +
                     "; ".join(f"{k.get('content', '').strip()} (todoist-{k['id']})" for k in kids))
    if len(title.encode()) > MAX_TITLE:
        parts.append(f"Full Todoist title: {title}")
        title = title.encode()[:MAX_TITLE].decode(errors="ignore")
    where = project + (f" / {section}" if section else "")
    prio = {4: "p1", 3: "p2", 2: "p3"}.get(item.get("priority", 1), "none")
    parts.append(f"Imported from Todoist on {today}: id {item['id']}, project {where}, "
                 f"priority {prio}, added {(item.get('added_at') or '')[:10]}.")
    notes_text = "\n\n".join(parts)
    if len(notes_text.encode()) > MAX_NOTES:
        notes_text = notes_text.encode()[:MAX_NOTES - 40].decode(errors="ignore") + "\n\n[truncated at import]"
        review.append("notes truncated to 20000 bytes")
    tags = ["todoist", slug(project)]
    if section:
        tags.append(slug(section))
    if review:
        tags.append("review")
    tags = list(dict.fromkeys(tags))[:MAX_TAGS]
    return {"id": f"todoist-{item['id']}", "title": title, "notes": notes_text, "tags": tags, "review": review}


def ops_for(task: dict) -> list:
    tid = task["id"]
    return [
        {"id": f"{tid}-capture", "type": "capture", "taskId": tid, "title": task["title"]},
        {"id": f"{tid}-notes", "type": "edit", "taskId": tid, "field": "notes", "value": task["notes"],
         "baseRevision": 1, "dependsOn": f"{tid}-capture"},
        {"id": f"{tid}-tags", "type": "edit", "taskId": tid, "field": "tags", "value": task["tags"],
         "baseRevision": 1, "dependsOn": f"{tid}-capture"},
    ]


def markdown_report(plan: dict, applied: dict | None = None) -> str:
    c = plan["counts"]
    out = [f"# Todoist → HOHE reconciliation ({plan['planned_at']})", "",
           "| Outcome | Tasks |", "| --- | --- |",
           f"| Imported | {c['import']} |", f"| Imported, needs review | {c['import_review']} |",
           f"| Excluded | {c['excluded']} |", f"| **Open in Todoist** | **{c['source_open']}** |", "",
           f"Balanced: **{'yes' if c['balanced'] else 'NO'}**", ""]
    if plan["excluded_by_reason"]:
        out += ["## Excluded, by reason", ""] + [f"- {r}: {n}" for r, n in sorted(plan["excluded_by_reason"].items())] + [""]
    if applied:
        out += ["## Apply", "", "| | Tasks |", "| --- | --- |"] + [f"| {k} | {v} |" for k, v in applied.items()] + [""]
    out += ["## Every task", "", "| Todoist id | Project | Outcome | Note |", "| --- | --- | --- | --- |"]
    for e in plan["entries"]:
        note = e.get("reason") or "; ".join(e.get("hohe", {}).get("review", []))
        title = e["title"].replace("|", "\\|")[:80]
        out.append(f"| {e['todoist_id']} | {e['project']} | {e['outcome']} | {title}{' — ' + note if note else ''} |")
    return "\n".join(out) + "\n"


# ── HOHE client ─────────────────────────────────────────────────────────────────────────

class Hohe:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header(CLIENT_HEADER, "1")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            die(f"{method} {path}: HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")

    def login(self, password: str):
        self.call("POST", "/api/login", {"password": password, "device": DEVICE_ID})

    def task_ids(self) -> set:
        ex = self.call("GET", "/api/export")
        return {t["id"] for t in ex["state"]["tasks"]}


# ── subcommands ─────────────────────────────────────────────────────────────────────────

def cmd_fetch(a):
    cfg = os.environ.get("TODOIST_CURL_CONFIG")
    if not cfg:
        die("TODOIST_CURL_CONFIG is not set; run under: parzival exec --as ai todoist-curl -- …", 2)
    token = None
    for line in open(cfg, encoding="utf-8"):
        m = re.match(r'\s*header\s*=\s*"Authorization: Bearer ([^"]+)"', line)
        if m:
            token = m.group(1)
    if not token:
        die("no Authorization header in the curl config", 2)
    body = urllib.parse.urlencode({"sync_token": "*", "resource_types": json.dumps(RESOURCE_TYPES)}).encode()
    req = urllib.request.Request(SYNC_URL, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    snap = json.loads(data)
    write_private(a.out, data)
    n = sum(1 for i in snap.get("items", []) if not i.get("is_deleted") and not i.get("checked"))
    print(f"fetched {n} open tasks in {len(snap.get('projects', []))} projects -> {a.out}")


def plan_from_args(a) -> dict:
    today = a.today or dt.date.today().isoformat()
    try:
        return build_plan(load_json(a.snapshot), load_json(a.split), today)
    except ValueError as e:
        die(str(e))


def write_reports(plan: dict, prefix: str, applied: dict | None = None):
    write_private(prefix + ".json", json.dumps(plan | ({"applied": applied} if applied else {}), indent=1,
                                               ensure_ascii=False).encode())
    write_private(prefix + ".md", markdown_report(plan, applied).encode())


def cmd_plan(a):
    plan = plan_from_args(a)
    c = plan["counts"]
    print(f"open {c['source_open']}: import {c['import']} + review {c['import_review']} + excluded {c['excluded']}"
          f"  balanced={c['balanced']}")
    for r, n in sorted(plan["excluded_by_reason"].items()):
        print(f"  excluded {n}: {r}")
    if a.report:
        write_reports(plan, a.report)
        print(f"report: {a.report}.md / .json")
    if not c["balanced"]:
        die("the reconciliation does not balance")


def cmd_apply(a):
    plan = plan_from_args(a)
    if not plan["counts"]["balanced"]:
        die("the reconciliation does not balance; nothing written")
    pwfile = os.environ.get("HOHE_LOGIN_PASSWORD_FILE")
    if not pwfile:
        die("HOHE_LOGIN_PASSWORD_FILE is not set; run under: parzival exec --as ansible hohe-login -- …", 2)
    password = open(pwfile, encoding="utf-8").read().strip()
    h = Hohe(a.hohe_url)
    h.login(password)
    existing = h.task_ids()
    todo = [e["hohe"] for e in plan["entries"] if e["outcome"].startswith("import")]
    skip = [t for t in todo if t["id"] in existing]
    new = [t for t in todo if t["id"] not in existing]
    print(f"to import {len(todo)}: already in HOHE {len(skip)}, new {len(new)}")
    bad = []
    for k in range(0, len(new), BATCH_TASKS):
        chunk = new[k:k + BATCH_TASKS]
        ops = [op for t in chunk for op in ops_for(t)]
        res = h.call("POST", "/api/sync", {"deviceId": DEVICE_ID, "ops": ops})
        for r in res.get("results", []):
            if r.get("status") not in ("applied", "noop"):
                bad.append(r)
        print(f"  batch {k // BATCH_TASKS + 1}: {len(chunk)} tasks, {len(ops)} ops")
    after = h.task_ids()
    missing = [t["id"] for t in todo if t["id"] not in after]
    applied = {"planned": len(todo), "already_present": len(skip), "created": len(new),
               "not_applied_ops": len(bad), "missing_after": len(missing)}
    if a.report:
        write_reports(plan, a.report, applied)
        print(f"report: {a.report}.md / .json")
    print(json.dumps(applied))
    if bad:
        print(json.dumps(bad[:10], indent=1), file=sys.stderr)
    if bad or missing:
        die("import incomplete: see the report", 1)
    print("IMPORT OK")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="read-only Todoist snapshot (under parzival todoist-curl)")
    f.add_argument("--out", required=True, help="new file to write, mode 0600; must not exist")
    for name in ("plan", "apply"):
        s = sub.add_parser(name)
        s.add_argument("--snapshot", required=True)
        s.add_argument("--split", required=True, help='JSON: {"hohe": [...], "donetick": [...], "exclude": {name: reason}}')
        s.add_argument("--report", help="path prefix for the .md and .json reconciliation report (new files)")
        s.add_argument("--today", help="override the import date (YYYY-MM-DD), for tests")
        if name == "apply":
            s.add_argument("--hohe-url", required=True)
    a = p.parse_args(argv)
    {"fetch": cmd_fetch, "plan": cmd_plan, "apply": cmd_apply}[a.cmd](a)


if __name__ == "__main__":
    main()
