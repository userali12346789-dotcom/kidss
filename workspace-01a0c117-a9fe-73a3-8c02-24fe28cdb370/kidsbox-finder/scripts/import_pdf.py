#!/usr/bin/env python3
"""
Import student data from "Repartition final.pdf" into the public JSON dataset.

  python3 scripts/import_pdf.py [path/to/Repartition final.pdf]

Source layout (verified against the school's workbook):
  - Pages 3-5   : "Résultat consolidé" sheet  -> N°, Nom et prénom, Classe d'origine, Cycle, Groupe
  - Pages 6-8   : continuation of the same sheet -> "Manuel attribué" + "Score (test)" columns,
                  row order identical to pages 3-5  (used ONLY to cross-validate the book;
                  the Score column is NEVER extracted into the dataset)
  - Pages 9-19  : per-group rosters ("Rang", "Nom et prénom (identifié)", "Score (test)")
                  -> used ONLY to discover students that appear in a group roster but are
                     missing from the consolidated sheet. They receive the group's book
                     (stated in the page header) and are flagged in the report.
  - Pages 1-2   : summary tables (stale counts) -> ignored.

Public fields exported per student: name, className, cycle, group, book.
NEVER exported: scores, ranking, confidence, remarks.
"""

import hashlib
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_OUT = ROOT / "server" / "data" / "students.json"

# cycle/group -> book, exactly as stated on pages 1-2 of the workbook ("Feuille correspondante")
BOOK_MAPPING = {
    (1, 1): "Kid's Box 1", (1, 2): "Kid's Box 2", (1, 3): "Kid's Box 2",
    (2, 1): "Kid's Box 3", (2, 2): "Kid's Box 3", (2, 3): "Kid's Box 4",
    (3, 1): "Kid's Box 5", (3, 2): "Kid's Box 5", (3, 3): "Kid's Box 6",
}

CLASS_ALIASES = {
    "cp a": "CPA", "cpb": "CPB", "cp b": "CPB", "cpa": "CPA",
    "ce1": "CE1", "ce2 a": "CE2 A", "ce2b": "CE2 B", "ce2 b": "CE2 B",
    "ce6 a": "CE6 A", "ce6 b": "CE6 B", "cm1": "CM1", "cm 1": "CM1", "cm2": "CM2",
}

CLS = r"(?:CPA|CPB|CP A|CP B|CE1|CE2 A|CE2 B|CE6 A|CE6 B|CM1|CM 1|CM2)"
CYC = r"(?:1er cycle \(CP-CE1\)|2e cycle \(CE2-CM1\)|3e cycle \(CM2-CE6\))"
RE_FULL = re.compile(rf"^(\d+)\s+(.+?)\s+({CLS})\s+({CYC})\s+Groupe (\d)\s*$")
RE_NONAME = re.compile(rf"^(\d+)\s+({CLS})\s+({CYC})\s+Groupe (\d)\s*$")
RE_BOOKROW = re.compile(r"^Kid's Box (\d+)\s+(\d+)\s*$")
RE_NAMEFRAG = re.compile(r"^[A-Za-zÀ-ÿ'’.\-]+$|^[A-Za-zÀ-ÿ'’.\- ]+$")
RE_GROUPLINE = re.compile(rf"^(\d+)\s+({CLS}|CE2B)\s+(.+?)\s*(\d+)?\s*$")
RE_GBOOK = re.compile(r"Manuel attribué à ce groupe\s*:\s*Kid's Box (\d+)")
RE_GRKEY = re.compile(r"GR\s*(\d)\b")


def norm(s):
    if s is None:
        return ""
    s = str(s).strip()
    s = unicodedata.normalize("NFKC", s).casefold()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^0-9a-z]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_class(c):
    c = " ".join(str(c).split())
    return CLASS_ALIASES.get(c.casefold(), c)


def cycle_of(txt):
    m = re.match(r"(\d)", txt)
    return int(m.group(1)) if m else None


def record_id(name, cls, group):
    return hashlib.sha256(f"{norm(name)}|{norm(cls)}|{group}".encode()).hexdigest()[:12]


def clean_name(name):
    name = name.replace("\n", " ")
    name = re.sub(r"\s{2,}", " ", name).strip()
    return name


def make_record(name, cls, cycle, group, book, book_source):
    return {
        "id": record_id(name, cls, group),
        "name": clean_name(name),
        "className": cls,
        "cycle": cycle,
        "group": group,
        "book": book,
        "bookSource": book_source,
    }


def parse_consolidated(pages):
    """State machine over all pages; returns (students, book_rows, anomalies)."""
    students, anomalies = [], []
    pending_fragments = []
    open_rec = None  # record awaiting a trailing name fragment

    def flush_open():
        nonlocal open_rec
        if open_rec is not None:
            students.append(open_rec)
            open_rec = None

    for pg, lines in pages:
        for raw in lines:
            ln = raw.strip()
            if not ln:
                continue
            m = RE_FULL.match(ln)
            if m:
                flush_open()
                if pending_fragments:
                    anomalies.append(f"page {pg}: stray name fragments dropped: {pending_fragments}")
                    pending_fragments = []
                name, cls, cyc, grp = m.group(2), m.group(3), m.group(4), int(m.group(5))
                students.append(make_record(name, norm_class(cls), cycle_of(cyc), grp, None, "pending"))
                continue
            m2 = RE_NONAME.match(ln)
            if m2:
                # name wrapped around this line (e.g. "KACHMI-EL MOHAMMED" / "101 CM2 ..." / "Rayane")
                cls, cyc, grp = m2.group(2), m2.group(3), int(m2.group(4))
                name = " ".join(pending_fragments)
                pending_fragments = []
                open_rec = make_record(name, norm_class(cls), cycle_of(cyc), grp, None, "pending")
                anomalies.append(f"page {pg}: wrapped name reconstructed -> {open_rec['name']!r} (continuation may follow)")
                continue
            if open_rec is not None and RE_NAMEFRAG.match(ln):
                open_rec["name"] = clean_name(open_rec["name"] + " " + ln)
                continue
            if open_rec is None and RE_NAMEFRAG.match(ln) and not any(
                t in ln for t in ("Résultat", "Classe", "N°", "Manuel", "Score", "Groupe", "cycle")
            ):
                pending_fragments.append(ln)
                continue
            # anything else on consolidated pages is header noise -> ignore
    flush_open()
    if pending_fragments:
        anomalies.append(f"unresolved name fragments: {pending_fragments}")
    return students, anomalies


def parse_group_pages(pages):
    """Parse per-group roster pages; return {group_key: {cycle, book, entries:[(class,name,score?)]}}."""
    groups, cur = {}, None
    for pg, lines in pages:
        for raw in lines:
            ln = raw.strip()
            if not ln:
                continue
            if ln.startswith(("1re & 2e", "3e & 4e", "5e & 6e")):
                gm = RE_GRKEY.search(ln)
                if gm:
                    g = int(gm.group(1))
                    cyc = 1 if ln.startswith("1re") else (2 if ln.startswith("3e") else 3)
                    cur = f"C{cyc}-G{g}"
                    groups[cur] = {"cycle": cyc, "book": BOOK_MAPPING.get((cyc, g)), "entries": []}
            elif "Manuel attribué à ce groupe" in ln and cur:
                bm = RE_GBOOK.search(ln)
                if bm:
                    groups[cur]["book"] = f"Kid's Box {bm.group(1)}"
            elif RE_GROUPLINE.match(ln) and cur:
                rm = RE_GROUPLINE.match(ln)
                rk, cls, name, score = rm.group(1), rm.group(2), rm.group(3), rm.group(4)
                groups[cur]["entries"].append({"rank": int(rk), "class": norm_class(cls), "name": clean_name(name), "score": score})
    return groups


def main():
    if len(sys.argv) > 1:
        path = Path(sys.argv[1])
    else:
        candidates = [
            Path("/home/user/uploads/Repartition final.pdf"),
            ROOT / "uploads" / "Repartition final.pdf",
            ROOT.parent / "uploads" / "Repartition final.pdf",
        ]
        path = next((c for c in candidates if c.exists()), candidates[0])
    if not path.exists():
        raise SystemExit(f"File not found: {path}")

    import pdfplumber

    pdf = pdfplumber.open(str(path))
    all_lines = {i + 1: (p.extract_text() or "").splitlines() for i, p in enumerate(pdf.pages)}

    # 1) consolidated sheet = pages whose rows match the full/noname row patterns
    cons_pages = []
    for pg, lines in all_lines.items():
        n = sum(1 for ln in lines if RE_FULL.match(ln.strip()) or RE_NONAME.match(ln.strip()))
        if n >= 5:
            cons_pages.append((pg, lines))
    if not cons_pages:
        raise SystemExit("Could not find the 'Résultat consolidé' sheet rows.")
    cons_pages.sort()

    students, anomalies = parse_consolidated(cons_pages)
    n_cons = len(students)

    # 2) book rows ("Manuel attribué" + score continuation pages) — same row order as consolidated sheet
    cons_page_set = {p for p, _ in cons_pages}
    book_rows = []
    for pg in sorted(all_lines):
        if pg in cons_page_set:
            continue
        for ln in all_lines[pg]:
            bm = RE_BOOKROW.match(ln.strip())
            if bm:
                book_rows.append(int(bm.group(1)))

    report_mismatch = []
    if len(book_rows) != n_cons:
        report_mismatch.append(f"BOOK ROW COUNT MISMATCH: {len(book_rows)} book rows vs {n_cons} students — check ordering!")
    else:
        for i, (rec, bk) in enumerate(zip(students, book_rows), start=1):
            mapped = BOOK_MAPPING.get((rec["cycle"], rec["group"]))
            rec["book"] = f"Kid's Box {bk}"  # the explicit "Manuel attribué" column is authoritative
            rec["bookSource"] = "database"
            if mapped != rec["book"]:
                report_mismatch.append(
                    f"row {i} {rec['name']!r} ({rec['className']}, C{rec['cycle']}-G{rec['group']}): "
                    f"mapping says {mapped!r} but 'Manuel attribué' says {rec['book']!r} -> using column value"
                )

    # 3) group roster pages -> discover students missing from the consolidated sheet
    group_pages = []
    for pg, lines in all_lines.items():
        if pg >= 9 and any(ln.strip().startswith(("1re & 2e", "3e & 4e", "5e & 6e")) for ln in lines):
            group_pages.append((pg, lines))
    group_pages.sort()
    groups = parse_group_pages(group_pages)

    known_names = {norm(r["name"]): r for r in students}
    extras, anomalies2 = [], []
    for gk in sorted(groups):
        g = groups[gk]
        for e in g["entries"]:
            nm = norm(e["name"])
            if nm in known_names:
                cons_rec = known_names[nm]
                if cons_rec["className"] != e["class"]:
                    anomalies2.append(
                        f"note: {e['name']!r} class in roster is {e['class']} but consolidated sheet has {cons_rec['className']} (kept consolidated)"
                    )
                continue
            if g["book"] is None:
                anomalies2.append(f"group {gk}: book unknown, cannot import extra {e['name']!r}")
                continue
            rec = make_record(e["name"], e["class"], g["cycle"], int(gk[-1]), g["book"], "group_page")
            extras.append(rec)
            known_names[nm] = rec
            anomalies2.append(f"extra student from {gk} roster (no score recorded): {e['name']!r} ({e['class']}) -> {g['book']}")

    students.extend(extras)

    # 4) dedupe + validate
    seen, final, dupes = set(), [], []
    for r in students:
        if not r["name"] or len(r["name"]) < 3 or not r["className"] or not r["group"] or not r["book"]:
            anomalies.append(f"invalid record skipped: {r}")
            continue
        key = (norm(r["name"]), norm(r["className"]))
        if key in seen:
            dupes.append(r["name"])
            continue
        seen.add(key)
        final.append(r)

    final.sort(key=lambda r: (r["name"].split()[0].casefold(), r["name"].casefold(), r["className"].casefold()))
    order = ["cpa", "cpb", "ce1", "ce2 a", "ce2 b", "ce6 a", "ce6 b", "cm1", "cm2"]
    classes = sorted(
        {r["className"] for r in final},
        key=lambda c: (order.index(norm_class(c).lower()) if norm_class(c).lower() in order else 99, c),
    )

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": path.name,
        "demo": False,
        "classes": classes,
        "students": final,
    }
    DATA_OUT.parent.mkdir(parents=True, exist_ok=True)
    DATA_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- report ----
    print(f"Dataset written: {DATA_OUT}")
    print(f"  total students: {len(final)}  (consolidated sheet: {n_cons}, from group rosters: {len(extras)})")
    per = {}
    for r in final:
        k = f"C{r['cycle']}-G{r['group']}"
        per.setdefault(k, {"n": 0, "books": set()})
        per[k]["n"] += 1
        per[k]["books"].add(r["book"])
    for k in sorted(per):
        print(f"  {k}: {per[k]['n']} students -> {', '.join(sorted(per[k]['books']))}")
    if report_mismatch:
        print("  book cross-validation mismatches:")
        for x in report_mismatch:
            print("    !", x)
    else:
        print("  book cross-validation: OK — every 'Manuel attribué' matches the documented cycle/group mapping")
    if dupes:
        print("  duplicates removed:", dupes)
    if anomalies:
        print(f"  parse notes ({len(anomalies)}):")
        for x in anomalies:
            print("    *", x)
    if anomalies2:
        print(f"  group-roster extras ({len(anomalies2)}):")
        for x in anomalies2:
            print("    *", x)
    missing = [r for r in final if not r["book"]]
    if missing:
        print("  WARNING: records without book:", missing)
    else:
        print("  validation: every record has name, class, group and Kid's Box book ✓")


if __name__ == "__main__":
    main()
