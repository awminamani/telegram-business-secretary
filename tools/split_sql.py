"""Split a SQL file into statements, respecting string literals and comments.

A naive split on ';' breaks as soon as a DEFAULT or comment contains one, which
silently applies a truncated CREATE TABLE. D1's /query takes ONE statement per
call, so this has to be exact.
"""
import re
import sys


def split_sql(sql: str):
    stmts, buf, i, n = [], [], 0, len(sql)
    in_s = in_d = in_line = in_block = False

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if in_line:
            if ch == "\n":
                in_line = False
                buf.append(ch)
            i += 1
            continue
        if in_block:
            if ch == "*" and nxt == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue
        if in_s or in_d:
            buf.append(ch)
            if ch == ("'" if in_s else '"'):
                # '' inside a literal is an escaped quote
                if nxt == ("'" if in_s else '"'):
                    buf.append(nxt)
                    i += 2
                    continue
                in_s = in_d = False
            i += 1
            continue

        # not in any literal/comment
        if ch == "-" and nxt == "-":
            in_line = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            in_block = True
            i += 2
            continue
        if ch == "'":
            in_s = True
            buf.append(ch)
            i += 1
            continue
        if ch == '"':
            in_d = True
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            stmts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)

    # drop comment-only / empty fragments
    out = []
    for s in stmts:
        stripped = re.sub(r"--[^\n]*", "", s)
        stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.S).strip()
        if stripped:
            out.append(stripped)
    return out


if __name__ == "__main__":
    for s in split_sql(open(sys.argv[1]).read()):
        print(s.split("\n")[0][:78], "...")
