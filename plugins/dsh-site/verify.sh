#!/bin/bash
# Acceptance checks for dsh-site. Exit 0 = all checks passed.
# Usage: ./verify.sh <tailnet-ip> [hostname] [port]
set -u
IP="${1:?usage: verify.sh <tailnet-ip> [hostname] [port]}"
HOST="${2:-}"
PORT="${3:-8443}"
LAN=$( (ipconfig getifaddr en0 || ipconfig getifaddr en1) 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

check() {
    if [ "$2" = 1 ]; then echo "PASS  $1  $3"; pass=$((pass + 1));
    else echo "FAIL  $1  $3"; fail=$((fail + 1)); fi
}

# 1. The edge is live and has found the shell.
h=$(curl -sS -m 6 "http://$IP:$PORT/.dsh-site/health" 2>/dev/null)
case "$h" in *'"ok":true'*) check "edge health" 1 "$h";; *) check "edge health" 0 "${h:-no response}";; esac

# 2. The GUI is served over the tailnet IP.
code=$(curl -sS -m 10 -o "$TMP/ip.html" -w '%{http_code}' "http://$IP:$PORT/" 2>/dev/null)
if [ "$code" = 200 ] && grep -q __DSH_BOOT__ "$TMP/ip.html"; then
    check "GUI over tailnet IP" 1 "status=$code"
elif [ "$code" = 401 ]; then
    check "GUI over tailnet IP" 1 "status=401 (shell auth is the gate; open the ?token= URL once)"
else
    check "GUI over tailnet IP" 0 "status=${code:-none}"
fi

# 3. A non-tailnet source is refused.
if [ -n "$LAN" ]; then
    lcode=$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "http://$LAN:$PORT/" 2>/dev/null)
    if [ "$lcode" = 403 ]; then check "non-tailnet source refused" 1 "LAN status=$lcode";
    else check "non-tailnet source refused" 0 "LAN status=${lcode:-none}"; fi
fi

# 4. Optional DNS name.
if [ -n "$HOST" ]; then
    resolved=$(dig +short "$HOST" 2>/dev/null | head -1)
    if [ -z "$resolved" ]; then
        check "name $HOST" 0 "no DNS record (add: A $IP, DNS only)"
    else
        hcode=$(curl -sS -m 10 -o "$TMP/host.html" -w '%{http_code}' "http://$HOST:$PORT/" 2>/dev/null)
        if [ "$hcode" = 200 ] || [ "$hcode" = 401 ]; then check "name $HOST" 1 "resolved=$resolved status=$hcode";
        else check "name $HOST" 0 "resolved=$resolved status=${hcode:-none}"; fi
    fi
fi

echo "---"
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
