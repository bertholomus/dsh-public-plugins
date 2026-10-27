#!/bin/bash
# Deployed checks for dsh-site, run on one of your devices (or on the Mac where it serves).
#
#   ./verify.sh <tailnet address> [name] [port]
#   ./verify.sh 100.101.102.103 mymac.example.ts.net 8443
#
# On a device: health; DSH's window over the address; the frame headers on its
# answer; a page on another site refused; a name not in allowHosts refused; the
# name (when given) served. On the Mac itself: the Mac turned away (unless
# allowThisMac is true, when the device checks run there too), and its LAN
# address refused (the connection closed). Exits non-zero if any check fails.
set -u
IP="${1:-}"
NAME="${2:-}"
PORT="${3:-8443}"
if [ -z "$IP" ]; then
    echo "usage: ./verify.sh <tailnet address> [name] [port]" >&2
    exit 2
fi
case "$IP" in *:*) HOSTPART="[$IP]";; *) HOSTPART="$IP";; esac
BASE="http://$HOSTPART:$PORT"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/dsh-site-verify.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0; skip=0

check() {
    if [ "$2" = 1 ]; then echo "PASS  $1  $3"; pass=$((pass + 1));
    else echo "FAIL  $1  $3"; fail=$((fail + 1)); fi
}
skipped() { echo "SKIP  $1  $2"; skip=$((skip + 1)); }

ON_MAC=0
if ifconfig 2>/dev/null | grep -q "inet $IP "; then ON_MAC=1; fi

# 6. On the Mac itself: a request from its LAN address gets no answer (the edge closes the connection
#    from an address outside allowCIDRs, or the port is not open on that address).
lan_check() {
    LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    if [ "$ON_MAC" = 1 ]; then
        if [ -n "$LAN" ]; then
            lc=$(curl -sS -m 6 -o "$TMP/lan.txt" -w '%{http_code}' "http://$LAN:$PORT/" 2>/dev/null)
            if [ "$lc" = 000 ] || grep -q 'this is the Mac DSH runs on' "$TMP/lan.txt" 2>/dev/null; then check "LAN address refused" 1 "no DSH (connection closed, the port is not open there, or the Mac turned away)";
            else check "LAN address refused" 0 "status=${lc:-none} (is the LAN range in allowCIDRs?)"; fi
        else
            skipped "LAN address refused" "no LAN address"
        fi
    else
        skipped "LAN address refused" "not run on the Mac that serves $IP"
    fi
}

finish() {
    echo "---"
    echo "pass=$pass fail=$fail skip=$skip"
    [ "$fail" -eq 0 ]
    exit $?
}

# 0. On the Mac itself, the edge turns the Mac away unless allowThisMac is true.
if [ "$ON_MAC" = 1 ]; then
    m=$(curl -sS -m 6 "$BASE/.dsh-site/health" 2>&1)
    case "$m" in
        *'this is the Mac DSH runs on'*)
            check "this Mac turned away (allowThisMac is false)" 1 "403"
            skipped "device checks" "run ./verify.sh on one of your devices for the rest"
            lan_check
            finish;;
    esac
fi

# 1. Health: listening, DSH found.
h=$(curl -sS -m 6 "$BASE/.dsh-site/health" 2>&1)
case "$h" in *'"ok":true'*) check "health" 1 "";; *) check "health" 0 "${h:-no answer}";; esac
auth=shell
case "$h" in *'"auth":"cookie"'*) auth=cookie;; esac

# 2. DSH's window over the address, with no cookie of this device's own.
code=$(curl -sS -m 10 -H 'Accept: text/html' -D "$TMP/window.head" -o "$TMP/window.html" -w '%{http_code}' "$BASE/" 2>/dev/null)
if [ "$auth" = cookie ]; then
    if [ "$code" = 200 ] && grep -q __DSH_BOOT__ "$TMP/window.html"; then check "DSH's window over $IP" 1 "200";
    else check "DSH's window over $IP" 0 "status=${code:-none} (signed in with the window's cookie: expected 200)"; fi
else
    # DSH's own sign-in is the gate: a device with no cookie gets DSH's sign-in answer.
    if [ "$code" = 401 ] || [ "$code" = 200 ]; then check "DSH answers over $IP (its own sign-in is the gate)" 1 "status=$code";
    else check "DSH answers over $IP" 0 "status=${code:-none}"; fi
fi

# 2b. Another site cannot show that answer in a frame (the browser obeys these headers).
if grep -qiE '^x-frame-options: *(sameorigin|deny)' "$TMP/window.head" 2>/dev/null \
    && grep -qiE "^content-security-policy:.*frame-ancestors '(self|none)'" "$TMP/window.head" 2>/dev/null; then
    check "frame headers on the answer" 1 "X-Frame-Options and frame-ancestors set"
else
    check "frame headers on the answer" 0 "missing X-Frame-Options or frame-ancestors"
fi

# 3. A page on another site cannot use DSH through the edge.
xs=$(curl -sS -m 6 -X POST -H 'Origin: http://evil.example' -H 'Sec-Fetch-Site: cross-site' -H 'Content-Type: application/json' \
    -d '{}' -o "$TMP/xs.txt" -w '%{http_code}' "$BASE/api/session/list" 2>/dev/null)
if [ "$xs" = 403 ] && grep -q 'refused cross-site request' "$TMP/xs.txt"; then check "another site refused" 1 "403";
else check "another site refused" 0 "status=${xs:-none} $(head -c 120 "$TMP/xs.txt" 2>/dev/null)"; fi

# 4. A name the owner did not list (DNS rebinding) is refused.
rb=$(curl -sS -m 6 -H "Host: rebind.attacker.example:$PORT" -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)
if [ "$rb" = 421 ]; then check "unlisted name refused" 1 "421";
else check "unlisted name refused" 0 "status=${rb:-none} (expected 421)"; fi

# 5. The name, when given, is served (it must be in allowHosts and resolve to this Mac).
if [ -n "$NAME" ]; then
    nc=$(curl -sS -m 10 -H 'Accept: text/html' -o "$TMP/name.html" -w '%{http_code}' "http://$NAME:$PORT/" 2>"$TMP/name.err")
    want=200; [ "$auth" = shell ] && want=401
    if [ "$nc" = "$want" ] || { [ "$auth" = shell ] && [ "$nc" = 200 ]; }; then check "name $NAME served" 1 "status=$nc";
    elif [ "$nc" = 421 ]; then check "name $NAME served" 0 "421: add $NAME to allowHosts";
    else check "name $NAME served" 0 "status=${nc:-none} $(head -c 120 "$TMP/name.err")"; fi
else
    skipped "name served" "no name given"
fi

case "$h" in
    *'"allowThisMac":true'*) skipped "LAN address refused" "allowThisMac is true, so this Mac's own LAN address counts as this Mac";;
    *) lan_check;;
esac
finish
