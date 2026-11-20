# Leak rules over a `git diff -U0` stream: ONE program, shared by public-sync.sh (leak check) and pre-pr-gate.sh.
# Reads only ADDED lines. Never prints a matched text: only "file:line" (with -v gate=1 also "  <rule>").
#   leak           the public-sync rules (always on)
#   secret-fixture gate only: a secret-looking literal in a test file (OpenAI, GitHub token and AWS key prefixes, Slack tokens, key=long literal)
#   name           gate only: a private word (env GATE_WORDS, one per line), whole word, any case
#   name-split     gate only: the same words once punctuation is stripped, over up to 3 consecutive added lines (split in literals or lines)
#   generic-name   gate only: a test line that reads the account or host name itself (use runtimePrivateWords(), which skips CI-generic names)
# Patterns are built by concatenation so this file never matches itself.

BEGIN {
  nw = 0
  if (gate) {
    c = split(tolower(ENVIRON["GATE_WORDS"]), raw, "\n")
    for (i = 1; i <= c; i++) {
      if (length(raw[i]) < 4 || (raw[i] in seenw)) continue        # the helper's own 4+ rule, on the raw word
      seenw[raw[i]] = 1; nw++; wraw[nw] = raw[i]; w = squash(raw[i]); words[nw] = (length(w) >= 4) ? w : ""   # split matching only when 4+ letters remain
    }
    gen_re = "(user" "Info|host" "name) *\\(|env\\.(USER|LOGNAME|HOSTNAME)([^A-Za-z0-9_]|$)|env\\[[\"'](USER|LOGNAME|HOSTNAME)[\"']\\]"
    tok = rep("[A-Za-z0-9_-]", 8) "[A-Za-z0-9_-]*"
    lead = "(^|[^A-Za-z0-9])"
    sec_re[1] = lead "sk" "-" tok
    sec_re[2] = lead "gh" "p_" tok
    sec_re[3] = lead "github" "_pat_" tok
    sec_re[4] = lead "AK" "IA" rep("[A-Z0-9]", 8)
    sec_re[5] = lead "xo" "x[bp]" "-" tok
    assign_re = "(key|token|secret|password)[a-z0-9_]*[\"']? *[:=] *[\"'][a-z0-9]" rep("[a-z0-9]", 15)
  }
}
# File headers are read only OUTSIDE a hunk: inside one, every "+" line is content, even one shaped like a header.
inh > 0 { if ($0 ~ /^\+/) { scan(substr($0, 2)); n++; inh-- } else if ($0 ~ /^-/) { inh-- } ; next }
/^\+\+\+ / { if ($0 ~ /^\+\+\+ b\//) f = substr($0, 7); else if ($0 ~ /^\+\+\+ "b\//) { f = substr($0, 8); sub(/"$/, "", f) } ; next }   # git-quoted names keep their file identity
/^@@/ { split($0, p, " "); o = p[2]; w = p[3]; sub(/^-/, "", o); sub(/^\+/, "", w)
        oc = (index(o, ",") ? substr(o, index(o, ",") + 1) : 1) + 0
        wc = (index(w, ",") ? substr(w, index(w, ",") + 1) : 1) + 0
        n = (w + 0); inh = oc + wc; wleft = wc; next }
function rep(s, k,   r) { r = ""; while (k-- > 0) r = r s; return r }
function squash(s) { s = tolower(s); gsub(/[^a-z0-9]/, "", s); return s }
function emit(rule) { if (gate) print f ":" n "  " rule "\t" curline; else print f ":" n }
function whole_word(text, wd,   t, st, q, b, a) {
  t = tolower(text); st = 1
  while ((q = index(substr(t, st), wd)) > 0) {
    q += st - 1; b = (q == 1) ? "" : substr(t, q - 1, 1); a = substr(t, q + length(wd), 1)
    if (b !~ /[a-z0-9]/ && a !~ /[a-z0-9]/) return 1
    st = q + 1
  }
  return 0
}
function istest(path) { return (path ~ /(^|\/)(_test|tests?|__tests__|fixtures?)\// || path ~ /\.(test|spec)\./) }
function scan(line) {
  curline = line
  if (line ~ ("/Us" "ers/[^/[:space:]<{$]") || line ~ ("nest" "oca") || line ~ ("(^|[^0-9])100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.[0-9]+\\.[0-9]+") || line ~ ("gh" "p_") || line ~ ("github" "_pat_") || line ~ ("sk-" "ant-") || line ~ ("PRIVATE" " KEY") || line ~ ("[A-Z0-9_]*(_API" "_KEY|_TOKEN|_SECRET) *= *[^ ]"))
    emit("leak")
  if (gate) gate_scan(line)
}
function gate_scan(line,   i, k, cur, prev, all, st, q, wd, hit, cross) {
  if (istest(f)) {
    for (k = 1; k <= 5; k++) if (line ~ sec_re[k]) { emit("secret-fixture"); break }
    if (k > 5 && tolower(line) ~ assign_re) emit("secret-fixture")
    if (f != "mods/_test/private-words.js" && line ~ gen_re) emit("generic-name")
  }
  if (nw > 0) {
    cur = squash(line)
    if (f != wf || n != wn + 1) { s1 = ""; s2 = "" }
    prev = s1 s2; all = prev cur
    for (i = 1; i <= nw; i++) {
      wd = words[i]; st = 1
      if (whole_word(line, wraw[i])) { emit("name"); continue }
      if (wd == "") continue
      hit = 0; cross = 0
      while ((q = index(substr(all, st), wd)) > 0) {
        q += st - 1
        if (q + length(wd) - 1 > length(prev)) { hit = 1; if (q <= length(prev)) cross = 1 }   # the word must end in THIS line
        st = q + 1
      }
      if (hit) { if (cross) curline = "\001cross-line"; emit("name-split"); curline = line }   # a cross-line hit cannot be allowlisted by its last line
    }
    s1 = s2; s2 = cur; wf = f; wn = n
  }
}
