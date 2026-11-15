"""A Channels row title that follows its stream (overrides.json "title_from": "stream", Everything-is-OK#793).

The row publishes row_title(<stored title of the stream it plays>): the first part (owner, 2026-11-15: "B. First part
only") of the title made calm by clean_title, at most one tablet line, or '' so the caller falls back to the slot's
fixed title. clean_title takes out emoji (the row's Noto font has none: 🔴 and 🔥 draw as empty boxes,
NotoSansCJKjp-Regular.otf, 2026-11-15), control and format characters, < and > (the world strips them from visitor names,
weather and captions), and the LIVE / 24/7 / Live Now: markers, and leaves no separator doubled or dangling and no empty
pair of brackets or quotes where something was taken out.
"""
import re, unicodedata

from . import config

GAP = "\x00"  # stands where something was taken out (a Cc character of the title itself becomes one too)
LIVE_STAMP = re.compile(r"\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$")  # yt-dlp appends this to a live title (its fulltitle doesn't)
TAG = re.compile(r"</?[A-Za-z][\w=#\"'. -]{0,40}>")  # "<b>", "</color>", "<size=200>": dropped whole, then any < or > left

# Separators (verifier, 2026-11-15, M1). BARS split a title into parts wherever they stand. DASHES (and / ~ ｰ) split only
# with spaces round them, since "Lo-Fi", "study/relax" and halfwidth katakana use them inside words. SOFT ones never split
# a part: commas, colons and the katakana middle dot ("安眠・リラックス" is one part). ATTACH ones are written against the
# word before them.
BARS = "·•|｜¦丨⋆‖／"
DASHES = "-–—~/ｰ"
SOFT = "・、，,:：;；"
SEPS = BARS + DASHES + SOFT
ATTACH = "、，,:：;；"
STOPS = "!?.。！？"
PAIRS = ["()", "[]", "{}", "【】", "「」", "『』", "（）", "〔〕", "《》", "〈〉", "«»", "‹›", "“”", "‘’", "„“", '""', "''"]
OPENERS, CLOSERS = "".join(p[0] for p in PAIRS), "".join(p[1] for p in PAIRS)
ONE_WAY_OPEN, ONE_WAY_CLOSE = "([{【「『（〔《〈«‹“‘„", ")]}】」』）〕》〉»›”’"  # not the straight quotes, which open and close

# A marker stands on its own: whitespace, a separator, a bracket or quote, a stop, or the end on each side. So "#live",
# "@live", "live.com", "Live-stream" and "Live—stream" are words, not markers.
_L = r"(?<![^\s%s])" % re.escape(BARS + SOFT + OPENERS + STOPS + "," + GAP)
_R = r"(?:(?![^\s%s])|(?=\.(?!\w)))" % re.escape(BARS + SOFT + CLOSERS + STOPS.replace(".", "") + "," + GAP)
# Matched on an NFKC copy, so ＬＩＶＥ, 𝐋𝐈𝐕𝐄 and ２４／７ are caught too. "live" goes only where it is a marker:
# "Live Now" (any case, a colon after it too), "live" beside 24/7, the all-caps LIVE, "(live)" alone in brackets; and in
# _lone_live a "live" with no word beside it or a "Live:" label at the start. 24/7 always goes. "Long Live the Night",
# "live music" and "Now Live: rain" stay.
MARKERS = re.compile(_L + r"(?i:live\s+now)" + _R + r"(?:\s*:)?"
                     + r"|(?<![\w/])(?:" + _L + r"(?i:live)\s+)?24\s*/\s*7(?![\w/])(?:\s+(?i:live)" + _R + r")?"
                     + r"|" + _L + r"LIVE" + _R
                     + r"|[" + re.escape(OPENERS) + r"]\s*(?i:live)\s*[" + re.escape(CLOSERS) + r"]")
LIVE_WORD = re.compile(r"(?<![\w-])(?i:live)(?![\w-])")
EMPTY_PAIRS = re.compile("|".join(re.escape(o) + r"[\s%s]*" % re.escape(SEPS + GAP) + re.escape(c) for o, c in PAIRS))
CLUSTER = re.compile(r"[\s%s]+" % re.escape(SEPS + GAP))
OPEN_SPACE = re.compile(r"([%s])\s+" % re.escape(ONE_WAY_OPEN))
SPACE_CLOSE = re.compile(r"\s+([%s])" % re.escape(ONE_WAY_CLOSE))
PARTS = re.compile(r"\s*[%s]\s*|\s+[%s]+\s+" % (re.escape(BARS), re.escape(DASHES)))
# At most one line of the tablet's Channels row: Title box 588.2 wide, 21 px Noto Sans CJK JP, Wrap + Truncate
# (EverythingIsOKTabletLayout.Channels.cs:181-183, 218-219). Measured with Pillow 2026-11-15 on the 47 seed stream titles
# wider than the box: one line held 53 to 62 units (median 57); an all-caps line 49; CJK 56 (28 characters). 64 is just
# above the most a line held, so the cap never takes a word the tablet would show; the row's Truncate still drops a line
# that doesn't fit, at a whole word, as it does for every title. The cap bounds what the doc carries (a 300-character
# title came out whole before), and the wall (same box at 17 px) shows up to about 69 units.
CAP_UNITS = 64


def _pictograph(ch):
    """Emoji and pictographs; CJK and fullwidth symbols stay (Japanese titles use them as text)."""
    cp, cat = ord(ch), unicodedata.category(ch)
    if 0x1F000 <= cp <= 0x1FAFF or cat in ("Co", "Cs"):
        return True  # emoji blocks (also any newer than this Python knows), private use, lone surrogates
    return cat == "So" and cp >= 0x2190 and not (0x2E80 <= cp <= 0x33FF or 0xFF00 <= cp <= 0xFFEF)


def _letter(ch):
    return unicodedata.category(ch)[0] in "LM"


BIDI = set("‎‏؜‪‫‬‭‮⁦⁧⁨⁩")
MAX_MARKS = 2  # combining marks kept in a row on one letter: Unity draws a taller stack over the row above (verifier, R2)


def _chars(t):
    """Character pass. A word is never split: a soft hyphen is deleted, ZWNJ and ZWJ stay between two letters (Persian
    "می‌خوابم") and are deleted elsewhere (a ZWJ left between emoji). A bidi control between two letters or digits becomes
    a space ("Rain‮Night" -> "Rain Night"), elsewhere it is deleted. Other format characters are deleted; control
    characters leave a gap; line breaks, tabs and wide spaces become a space; a third combining mark in a row is dropped."""
    out, marks = [], 0
    for i, c in enumerate(t):
        cp, cat = ord(c), unicodedata.category(c)
        between = 0 < i < len(t) - 1
        if c in "\t\n\r\v\f" or cat in ("Zs", "Zl", "Zp") or c == "​":
            out.append(" ")
        elif cat == "Cc":
            out.append(GAP)  # \x00, \x07, \x1b...: gone, and never glues two words together
        elif c in "‌‍":
            if between and _letter(t[i - 1]) and _letter(t[i + 1]):
                out.append(c)
        elif c in BIDI:
            if between and t[i - 1].isalnum() and t[i + 1].isalnum():
                out.append(" ")
        elif cat == "Cf" or cat == "Me" or 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF:
            continue  # soft hyphen, tags, keycaps, variation selectors
        elif c in "<>" or _pictograph(c):
            out.append(GAP)
        elif cat == "Mn":
            marks += 1
            if marks <= MAX_MARKS:
                out.append(c)
            continue
        else:
            out.append(c)
        marks = 0
    return out


def _fold(chars):
    """NFKC copy of chars and, for each of its characters, the index of the character it came from."""
    out, src = [], []
    for i, c in enumerate(chars):
        for f in (c if c == GAP else unicodedata.normalize("NFKC", c)):
            out.append(f)
            src.append(i)
    return "".join(out), src


def _blank(chars, src, a, b):
    for k in range(src[a], src[b - 1] + 1):
        chars[k] = GAP


def _breaks(s, k):
    """Is s[k] a place a lone "live" may stand next to: a separator, bracket or quote (a dash only with spaces)?"""
    c = s[k]
    if c in BARS + SOFT + OPENERS + CLOSERS:
        return True
    return c in DASHES and (k == 0 or s[k - 1].isspace()) and (k + 1 == len(s) or s[k + 1].isspace())


def _lone_live(chars):
    """"Finse station - Live", "🔥 · live · 🔥", "Live: Campfire": a "live" with no word of its own beside it."""
    s, src = _fold(chars)
    for m in reversed(list(LIVE_WORD.finditer(s))):
        i, j = m.start() - 1, m.end()
        while i >= 0 and (s[i].isspace() or s[i] == GAP):
            i -= 1
        while j < len(s) and (s[j].isspace() or s[j] == GAP):
            j += 1
        if (i < 0 or _breaks(s, i)) and (j == len(s) or _breaks(s, j)):  # ":" is a break, so "Live:" goes too
            _blank(chars, src, m.start(), m.end())


def _cluster(m):
    """A run of spaces, separators and gaps. Left as it was unless something was taken out in it, or a separator is
    doubled; then one separator stays (a splitting one before a soft one), written the way the run was spaced."""
    s = m.group()
    seps = [c for c in s if c in SEPS]
    ws = any(c.isspace() for c in s)
    doubled = any(a == b and a in BARS + SOFT for a, b in zip(seps, seps[1:])) or (ws and len(seps) > 1)
    if GAP not in s and not doubled:
        return " " if not seps else re.sub(r"\s+", " ", s)
    if not seps:
        return " "
    split = [c for c in seps if c in BARS or (c in DASHES and ws)]
    k = split[0] if split else seps[0]
    if k in ATTACH:
        return k + (" " if ws else "")
    return " %s " % k if ws else k


def _word(w):
    return any(c.isalnum() for c in w)


def clean_title(raw):
    """The stream's whole title, calm: '' when nothing worth showing is left. row_title takes its first part."""
    chars = _chars(TAG.sub(GAP, LIVE_STAMP.sub("", raw or "")))
    s, src = _fold(chars)
    for m in reversed(list(MARKERS.finditer(s))):
        _blank(chars, src, m.start(), m.end())
    _lone_live(chars)
    t = "".join(chars)
    while EMPTY_PAIRS.search(t):
        t = EMPTY_PAIRS.sub(GAP, t)
    t = CLUSTER.sub(_cluster, t).replace(GAP, " ")
    t = SPACE_CLOSE.sub(r"\1", OPEN_SPACE.sub(r"\1", t))
    words = []
    for w in t.split():
        if not _word(w) and (not words or not _word(words[-1])):
            continue  # nothing before it, or a second mark in a row
        words.append(w)
    while words and not _word(words[-1]):
        words.pop()
    t = " ".join(words).lstrip(SEPS + STOPS).rstrip(SEPS).strip()
    return t if _word(t) else ""


def _units(t):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.category(c) == "Mn" else 1 for c in t)


def _wide(t):
    return any(unicodedata.east_asian_width(c) in "WF" for c in t)


# Bracket and quote pairs a published title keeps whole (verifier R2-M1): never split or cut inside one, never leave one
# open or unopened. Not the apostrophes (' ‘ ’), which stand alone in "Link's" and "90’s". The straight double quote
# opens and closes; “ closes a „ and opens a “”.
TRACKED = [p for p in PAIRS if p not in ("‘’", "''")]
OPENS = {p[0]: p[1] for p in TRACKED if p[0] != p[1]}
CLOSES = set(p[1] for p in TRACKED if p[0] != p[1])


def _unmatched(t):
    """Indices of the tracked bracket and quote characters in t that have no partner."""
    stack, bad = [], set()
    for i, c in enumerate(t):
        if c == '"':
            if stack and stack[-1][0] == '"':
                stack.pop()
            else:
                stack.append((c, i))
        elif c == "“" and stack and stack[-1][0] == "„":
            stack.pop()
        elif c in OPENS:
            stack.append((c, i))
        elif c in CLOSES:
            if stack and OPENS.get(stack[-1][0]) == c:
                stack.pop()
            else:
                bad.add(i)
    return bad | {i for _, i in stack}


def _depth(t):
    """For each index, how many tracked pairs are open there."""
    stack, out = [], []
    for c in t:
        out.append(len(stack))
        if c == '"':
            if stack and stack[-1] == '"':
                stack.pop()
            else:
                stack.append(c)
        elif c == "“" and stack and stack[-1] == "„":
            stack.pop()
        elif c in OPENS:
            stack.append(c)
        elif c in CLOSES and stack and OPENS.get(stack[-1]) == c:
            stack.pop()
    return out


def _tidy(t):
    t = SPACE_CLOSE.sub(r"\1", OPEN_SPACE.sub(r"\1", re.sub(r"\s+", " ", t)))
    words = t.split()
    while words and not _word(words[-1]):
        words.pop()  # "... Quadrilla +", "... Relaxation &"
    while words and not _word(words[0]):
        words.pop(0)
    # Spaces with the separators: "丨 —‘…" (丨 is a CJK letter to Python, so it is a word above) must lose both.
    return " ".join(words).lstrip(" " + SEPS + STOPS).rstrip(" " + SEPS)


def _balance(t):
    """t without the bracket and quote characters that have no partner (a title that came that way)."""
    bad = _unmatched(t)
    return "".join(c for i, c in enumerate(t) if i not in bad) if bad else t


def _final(t):
    """Drop unpaired brackets and quotes, then empty pairs, then tidy the ends, until nothing changes. Each step only
    takes characters away, so this ends; when it does, a published title has no unpaired or empty pair and doesn't start
    or end with a separator (fuzzing found each step can undo another: "〈)〉" -> "〈〉", "（き /）" -> "（き")."""
    for _ in range(len(t) + 1):
        u = _balance(t)
        while EMPTY_PAIRS.search(u):
            u = EMPTY_PAIRS.sub(" ", u)
        u = _tidy(u)
        if u == t:
            break
        t = u
    return t


def _parts(t):
    """t split at the part separators that stand outside every bracket and quote pair: "Night Train (Tokyo – Osaka)
    ambience" is one part."""
    depth, out, at = _depth(t), [], 0
    for m in PARTS.finditer(t):
        if depth[m.start()] == 0 and (m.end() == len(t) or depth[m.end() - 1] == 0):
            out.append(t[at:m.start()])
            at = m.end()
    return out + [t[at:]]


def _bare(p):
    """A part too thin to stand for the stream: one token under 4 units ("A", "4K") or no letter at all ("2024")."""
    return (" " not in p and _units(p) < 4) or not any(c.isalpha() for c in p)


def _cap(t):
    """At most CAP_UNITS (wide characters count two), cut after a whole word; a run with no space that holds wide (CJK)
    characters, or a title with no space at all, is cut where it is full. A pair the cut would leave open is cut back to
    before its opener. No ellipsis: the row never had one."""
    n = 0
    for i, c in enumerate(t):
        n += _units(c)
        if n > CAP_UNITS:
            head = t[:i]
            sp = head.rfind(" ")
            if not t[i].isspace() and sp > 0 and not _wide(head[sp + 1:] + t[i]):
                head = head[:sp]  # a whole word
            opened = sorted(k for k in _unmatched(head) if head[k] in OPENS or head[k] in '"„')
            if opened:
                before = _tidy(head[:opened[0]])
                head = before if _word(before) else _balance(head)
            return _tidy(head)
    return t


def banned(raw):
    """The words a replacement stream may not carry (config.BANNED_WORDS, core.judge_candidate), in any form."""
    t = unicodedata.normalize("NFKC", raw or "").casefold()
    return any(w in t for w in config.BANNED_WORDS)


def row_title(raw):
    """What a followed row shows: the first part of the cleaned title with a word in it that isn't bare, its brackets and
    quotes whole, capped at CAP_UNITS; '' (the caller falls back to the fixed title) when there is none, or when the
    title has a banned word anywhere in it."""
    if banned(raw):
        return ""
    for part in _parts(clean_title(raw)):
        part = _final(part)
        if _word(part) and not _bare(part):
            out = _final(_cap(part))
            if _word(out):
                return out
    return ""
