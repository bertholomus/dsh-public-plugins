import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendOf, codeSendOf, splitShell, placeOf, hostOf } from '../plugins/coordinator/lib/sends.js';

// What a project thread's command sends outside the workspace (plugins/coordinator/lib/sends.js): the plugin asks the
// user before each one. The files a command names are read through `read`, here from this table.
const files = {
  '/w/deploy.sh': '#!/bin/bash\ncurl -X POST http://127.0.0.1:8787/deploy -d "{}"\n',
  '/w/build.sh': '#!/bin/bash\nnpm ci\nnpm run build\n',
  '/w/release.sh': '#!/bin/bash\necho hi\n',
  '/w/push.py': 'import requests\nrequests.get("http://x")\n',
  '/w/send.py': 'import requests\nrequests.post("http://x/deploy", json={})\n',
  '/w/package.json': JSON.stringify({ scripts: { build: 'tsc', deploy: 'vercel --prod', test: 'node --test', ship: 'echo ok', release: 'npm publish', prerelease: 'npm test', lint: 'eslint .', 'push-docs': 'echo local' } }),
  '/w/Makefile': 'all: build\nbuild:\n\tnpm run build\ndeploy: build\n\t@curl -X POST http://x/deploy\nclean:\n\trm -rf dist\n',
  '/w/scripts/notify.js': 'console.log(1)\n',
  '/w/sub/package.json': JSON.stringify({ scripts: { deploy: 'firebase deploy' } }),
  '/w/v/package.json': JSON.stringify({ scripts: { postversion: 'git push --follow-tags' } }),
  '/w/m/Makefile': 'all: deploy\ndeploy:\n\t./deploy.sh\n',
  '/w/m/deploy.sh': '#!/bin/sh\nrsync -a dist/ host:/www\n',
  '/w/ax.py': 'import httpx\nasync def go(u):\n    async with httpx.AsyncClient() as client:\n        await client.post(u)\n',
  '/w/f.mjs': 'const r = await fetch(u, { method: "POST", body });\n',
  '/w/sp.mjs': "import { spawn } from 'node:child_process';\nspawn('git', ['push', 'origin', 'main']);\n",
  '/w/test/api.test.js': 'await fetch("http://localhost:3000/api", { method: "POST" });\n',
  '/w/server.js': "const app = require('express')();\napp.post('/api', (req, res) => res.send('ok'));\napp.listen(3000);\n",
  '/w/log.mjs': "console.log('git push failed, run git push again');\n",
  '/w/nas/deploy.sh': '#!/bin/sh\nrsync -av dist/ homenas:/data/www/\n',
  '/w/nas/both.sh': '#!/bin/sh\nssh homenas ls /data\ncurl -X POST https://example.com/hook\n',
};
const at = { cwd: '/w', read: (path) => files[path] };

const SENDS = [
  // Round-1 probes: Perl's web clients and OpenSSL's TLS client.
  `perl -MLWP::UserAgent -e 'LWP::UserAgent->new->post("http://x/y", {a=>1})'`,
  `perl -MHTTP::Tiny -e 'HTTP::Tiny->new->request("POST", "http://x/y", {content=>"a"})'`,
  `perl -MLWP::UserAgent -MHTTP::Request::Common -e '$ua=LWP::UserAgent->new; $ua->request(POST "http://x/y", [a=>1])'`,
  'openssl s_client -connect example.com:443',
  'printf "GET / HTTP/1.0\\r\\n\\r\\n" | openssl s_client -quiet -connect example.com:443',
  'curl -X POST http://127.0.0.1:8787/deploy',
  'curl -sS -X POST -H "Content-Type: application/json" -d \'{"a":1}\' http://127.0.0.1:8787/deploy',
  'curl -sSLXPOST http://x/y',
  'curl -d@body.json http://x/y',
  'curl --data "a=1" http://x/y',
  'curl --json \'{}\' http://x/y',
  'curl -F file=@a http://x/upload',
  'curl -T file ftp://x/',
  'curl --request DELETE https://api/x/1',
  'curl -X PUT https://api/x/1',
  'cd /w && curl -s -X POST localhost:8787/deploy | jq .',
  'echo $(curl -X POST http://x/deploy)',
  'X=1 curl -X POST http://x',
  'sudo -u bob curl -X POST http://x',
  'timeout 30 curl -X POST http://x',
  'env TOKEN=abc curl -X POST http://x',
  'wget --post-data="a=1" http://x/y',
  'wget --method=DELETE http://x/y',
  'http POST http://x/y a=1',
  'http http://x/y a=1',
  'xh put x/y a:=1',
  'git push',
  'git push origin main',
  'git -C repo push --force',
  'git commit -m x && git push',
  'gh pr create --title x --body y',
  'gh pr merge 3 --squash',
  'gh api -X POST repos/a/b/issues -f title=x',
  'gh api repos/a/b/issues -f title=x',
  'gh api graphql -f query="mutation { x }"',
  'gh release create v1',
  'gh issue comment 3 --body hi',
  'npm publish',
  'npm publish --access public',
  'pnpm publish',
  'yarn npm publish',
  'cargo publish',
  'twine upload dist/*',
  'python -m twine upload dist/*',
  'python3 -m twine upload dist/*',
  'poetry publish --build',
  'docker push me/img:1',
  'docker buildx build --push -t x .',
  'kubectl apply -f k.yaml',
  'kubectl rollout restart deploy/x',
  'helm upgrade --install x ./chart',
  'terraform apply -auto-approve',
  'tofu destroy',
  'pulumi up --yes',
  'vercel --prod',
  'vercel deploy',
  'npx vercel --prod',
  'npx netlify-cli deploy --prod',
  'netlify deploy --prod',
  'firebase deploy',
  'wrangler deploy',
  'npx wrangler@3 deploy',
  'fly deploy',
  'flyctl deploy',
  'heroku config:set A=1',
  'aws s3 cp x s3://b/x',
  'aws s3 sync . s3://b',
  'aws lambda update-function-code --function-name x',
  'aws --profile p ec2 terminate-instances --instance-ids i-1',
  'gcloud run deploy svc --image x',
  'az group delete -n x',
  'ssh prod-1 "systemctl restart app"',
  'ssh -i key user@host',
  'scp a.txt prod-1:/tmp/',
  'rsync -avz dist/ user@host:/var/www/',
  'sendmail bob@x.com < msg',
  'mail -s hi bob@x.com',
  'swaks --to bob@x',
  './deploy.sh',
  'bash deploy.sh',
  'sh ./deploy.sh',
  'bash -c "curl -X POST http://x"',
  'python3 send.py',
  'python3 -c "import requests; requests.post(\'http://x\')"',
  'node -e "fetch(\'http://x\', {method: \'POST\'})"',
  'npm run deploy',
  'npm run release',
  'yarn deploy',
  'pnpm run deploy',
  'make deploy',
  'python3 - <<EOF\nimport requests\nrequests.post("http://x")\nEOF',
  'cat <<EOF | python3\nimport requests\nrequests.post("http://x")\nEOF',
  'python3 <<< "import requests; requests.post(1)"',
  'nc host 25',
  'just deploy',
  'rake deploy',
  'scripts/notify.js',
  'node scripts/notify.js',
  'curl -X POST http://x/y > out.txt 2>&1',
  'eval "curl -X POST http://x"',
  'xargs -I{} curl -X POST http://x/{}',
  'find . -name x | xargs curl -X POST http://x',
  'semantic-release',
  'npx semantic-release',
  'goreleaser release --clean',
  'mvn deploy',
  './gradlew publish',
  'ansible-playbook site.yml',
  'Invoke-RestMethod -Method Post -Uri http://x',
  'aws-vault exec prod -- aws s3 rm s3://b/x',
  'op run -- curl -X POST http://x',
  'uvx twine upload dist/*',
  'uv publish',
  'osascript -e \'tell application "Messages" to send "hi" to buddy "x"\'',
  'git send-email *.patch',
  'gh workflow run deploy.yml',
  'stripe customers create --email x',
  'docker compose push',
  'rclone copy dist remote:bucket',
  'gsutil cp x gs://b/x',
  'curl https://x -X POST',
  'curl -XPOST https://x',
  'echo hi; curl -X POST http://x',
  '(cd x && curl -X POST http://x)',
  'if true; then curl -X POST http://x; fi',
  'for i in 1 2; do curl -X POST http://x/$i; done',
  'npm run ship',
  'docker buildx build --push -t x .',
  'docker build --push -t x .',
  'docker buildx build --output type=registry -t x .',
  'uv publish',
  'uv tool run twine upload dist/*',
  'cd /w && ./deploy.sh',
  'cd sub && npm run deploy',
  'find dist -name "*.zip" -exec curl -T {} ftp://x/ \\;',
  'echo "import requests; requests.post(1)" | python3',
  'cd m && make',
  'make -C m all',
  'node -e "require(\'child_process\').execSync(\'git push\')"',
  "python3 -c \"import subprocess; subprocess.run(['git', 'push'])\"",
  'npm --registry https://r.example publish',
  'cd v && npm version patch',
  'wrangler d1 execute db --remote --command "drop table x"',
  'gcloud builds submit',
  'node scripts/release.js',
  'python3 ax.py',
  'node f.mjs',
  'node sp.mjs',
  'git push origin HEAD:main',
  'gh api -X PATCH repos/a/b -f description=x',
  'kubectl --context prod apply -f k.yaml',
  'helm --kube-context prod upgrade x ./c',
];

const READS = [
  `perl -MHTTP::Tiny -e 'print HTTP::Tiny->new->get("http://x/y")->{content}'`,
  `perl -e 'my %h=(a=>1); delete $h{a}; print 1'`,
  'openssl x509 -in cert.pem -noout -text',
  'openssl rand -hex 16',
  'curl http://127.0.0.1:8787/health',
  'curl -s https://x/y | jq .',
  'curl -I https://x',
  'curl -G -d q=1 https://x/search',
  'curl -o out.zip https://x/file.zip',
  'curl -sSL https://get.x.sh | head',
  'curl -H "Authorization: Bearer x" https://api/x',
  'wget https://x/file',
  'http GET x/y',
  'http x/y q==1',
  'git status',
  'git pull',
  'git fetch origin',
  'git clone https://github.com/a/b',
  'git push --dry-run',
  'git commit -m "push to prod later"',
  'git log --grep=deploy',
  'gh pr view 3',
  'gh pr list',
  'gh api repos/a/b',
  'gh api graphql -f query="{ viewer { login } }"',
  'gh issue list',
  'npm install',
  'npm ci',
  'npm test',
  'npm run build',
  'npm run lint',
  'npm run test -- --watch',
  'yarn install',
  'yarn build',
  'pnpm install',
  'pnpm deploy ./out',
  'cargo build',
  'cargo test',
  'docker build -t x .',
  'docker run --rm x',
  'docker pull x',
  'kubectl get pods',
  'kubectl apply --dry-run=client -f k.yaml',
  'kubectl diff -f k.yaml',
  'helm template x ./chart',
  'terraform plan',
  'terraform init',
  'pulumi preview',
  'vercel dev',
  'vercel build',
  'vercel env ls',
  'vercel ls',
  'netlify status',
  'aws s3 ls',
  'aws s3 cp s3://b/x .',
  'aws sts get-caller-identity',
  'aws ec2 describe-instances',
  'gcloud config set project x',
  'gcloud compute instances list',
  'az account show',
  'ssh -G host',
  'scp host:/tmp/a .',
  'rsync -av src/ dst/',
  'make',
  'make build',
  'make clean',
  'make test',
  'ls -la',
  'cat deploy.sh',
  'grep -r deploy .',
  'echo "curl -X POST http://x"',
  'echo git push',
  'printf "%s\\n" "git push"',
  'vim deploy.sh',
  'chmod +x deploy.sh',
  './build.sh',
  'bash build.sh',
  'python3 -c "import requests; print(requests.get(\'http://x\').text)"',
  'python3 push.py',
  'node -e "console.log(1)"',
  'cat > deploy.sh <<EOF\ncurl -X POST http://x\nEOF',
  'npm run push-docs',
  'nc -z host 80',
  'nc -l 9000',
  'goreleaser release --snapshot --clean',
  'semantic-release --dry-run',
  'ansible-playbook --check site.yml',
  'ansible all -m ping',
  'Invoke-RestMethod -Uri http://x',
  'which curl',
  'command -v vercel',
  'man curl',
  'curl --help',
  'git push -n',
  'echo $(curl http://x)',
  'test -f deploy.sh && echo yes',
  'node scripts/build.js',
  'python3 -m pytest',
  'python3 -m http.server 8000',
  'npx tsc',
  'npx eslint .',
  'npx prettier --write .',
  'gradle build',
  'mvn package',
  'grpcurl -plaintext localhost:50051 list',
  'stripe customers list',
  'heroku logs --tail',
  'fly status',
  'firebase emulators:start',
  'wrangler dev',
  'wrangler d1 execute db --local --command "select 1"',
  'git remote -v',
  'git diff',
  './release.sh',
  'sed -i "s/push/pull/" file',
  'rm -rf dist',
  'cp -r a b',
  'mv a b',
  'touch deploy.log',
  'node --test test/api.test.js',
  'python3 -m pytest tests/test_api.py',
  'node test/e2e/run.mjs',
  "node -e \"console.log('git push')\"",
  'node log.mjs',
  'node server.js',
  'make -n deploy',
  'gh pr create --help',
  'cd "$X" && ./build.sh',
  'docker build -t x .',
  'cd sub && npm run build',
  'npm version patch',
  'curl --version',
  'git push --help',
  'docker compose up -d',
  'kubectl port-forward svc/x 8080:80',
  'kubectl logs -f deploy/x',
  'gcloud storage ls gs://b',
  'aws s3 mv s3://b/x s3://b/y --dryrun',
];

test('sends: requests that do more than read, pushes, publishes, deploys, remote commands, email, and what runs them', () => {
    for (const command of SENDS) assert.ok(sendOf(command, at), `a send: ${command}`);
});

test('sends: reads, local work, dry runs, syntax checks, help and tests are no send', () => {
    for (const command of READS) assert.equal(sendOf(command, at), null, `no send: ${command}`);
});

test('sends: what a send says, after "it"', () => {
    const said = (command) => sendOf(command, at)?.what;
    assert.equal(said('curl -sS -X POST -H "Content-Type: application/json" --data @build.json http://127.0.0.1:8787/deploy?x=1'), 'sends a POST to 127.0.0.1:8787/deploy (curl)');
    assert.equal(said('curl -T f https://user:pw@files.example.com/up/'), 'sends a PUT to files.example.com/up/ (curl)');
    assert.equal(said('git push origin main'), 'pushes to origin (git push)');
    assert.equal(said('gh pr create --fill'), 'makes a change on GitHub (gh pr create)');
    assert.equal(said('gh api repos/a/b/issues -f title=x'), 'sends a POST to the GitHub API (gh api repos/a/b/issues)');
    assert.equal(said('npx vercel --prod'), 'deploys (vercel)');
    assert.equal(said('aws s3 sync dist s3://site'), 'copies to S3 (aws s3 sync → site)');
    assert.equal(said('scp a.txt prod-1:/tmp/'), 'copies files to prod-1 (scp)');
    assert.equal(said('echo | openssl s_client -connect example.com:443 -showcerts'), 'opens a raw connection to example.com:443 (openssl s_client)');
    assert.equal(said(`perl -MLWP::UserAgent -e 'LWP::UserAgent->new->put("http://x/y")'`), 'runs code that sends a PUT (perl)');
    assert.equal(said('./deploy.sh'), 'runs ./deploy.sh, which can send a POST to 127.0.0.1:8787/deploy (curl)');
    assert.equal(said('cd sub && npm run deploy'), 'runs npm run deploy, which can make a change on Firebase (firebase deploy)');
    assert.equal(said('make -C m'), 'runs make all, which can run ./deploy.sh, which can copy files to host (rsync)');
    assert.equal(said('node scripts/release.js'), 'runs scripts/release.js, whose name says it releases');
    assert.equal(said("python3 -c \"import subprocess; subprocess.run(['git', 'push'])\""), 'runs code that pushes to its remote (git push)');
    assert.deepEqual(sendOf('sendmail bob@example.com < msg', at), { kind: 'email', program: 'sendmail', what: 'sends email (sendmail)' });
    assert.equal(placeOf('https://user@api.example.com:8443/v1/items?token=secret#x'), 'api.example.com:8443/v1/items');
});

test('sends: a file is read only through the caller, and not from a folder it can\'t tell', () => {
    const asked = [];
    const read = (path) => { asked.push(path); return files[path]; };
    assert.ok(sendOf('cd m && ./deploy.sh', { cwd: '/w', read }));
    assert.deepEqual(asked, ['/w/m/deploy.sh']);
    asked.length = 0;
    // Somewhere it can't tell: only the name counts (a deploy script's does).
    assert.ok(sendOf('cd "$DIR" && ./deploy.sh', { cwd: '/w', read }));
    assert.equal(sendOf('cd ~/x && ./build.sh', { cwd: '/w', read }), null);
    assert.equal(sendOf('./build.sh', { read }), null);
    assert.deepEqual(asked, []);
    // A name that only might send counts when what it runs can't be read.
    assert.ok(sendOf('./release.sh', { cwd: '/elsewhere', read }));
    assert.equal(sendOf('./release.sh', at), null);
});

test('sends: code sends by its requests; its strings count as commands only where it runs commands', () => {
    assert.equal(codeSendOf("await fetch(url, { method: 'PATCH', body })")?.what, 'runs code that sends a PATCH (code)');
    assert.equal(codeSendOf('requests.post(url, json=body)', undefined, 'python3')?.what, 'runs code that sends a POST (python3)');
    assert.equal(codeSendOf('import smtplib')?.kind, 'email');
    assert.equal(codeSendOf("console.log('next: git push origin main')"), null);
    assert.equal(codeSendOf("require('child_process').execSync('git push origin main')")?.what, 'runs code that pushes to origin (git push)');
    assert.equal(codeSendOf("spawn('npm', ['publish'])\n// child_process")?.what, 'runs code that publishes (npm publish)');
    assert.equal(codeSendOf("app.post('/api', handler)"), null);
    assert.equal(codeSendOf('await fetch(url)'), null);
});

test('sends: the shell\'s words, quotes, here-documents and nested commands', () => {
    const { commands, nested } = splitShell('A=1 echo "a $(curl -X POST http://x) b" \'c d\' 2>&1 | tee out; cat <<-EOF > f\n\tline one\n\tEOF\necho `git push`');
    assert.deepEqual(commands.map((c) => c.words), [['A=1', 'echo', 'a $(curl -X POST http://x) b', 'c d'], ['tee', 'out'], ['cat'], ['echo', '`git push`']]);
    assert.deepEqual(commands.map((c) => c.pipe), [true, false, false, false]);
    assert.deepEqual(commands[2].inputs, ['line one']);
    assert.deepEqual(nested, ['curl -X POST http://x', 'git push']);
    assert.ok(sendOf('echo "$(curl -X POST http://x)"'));
    assert.equal(sendOf('# git push\necho done'), null);
    assert.equal(sendOf("echo 'git push'"), null);
    assert.ok(sendOf('git commit -m "x" \\\n  && git push'));
});

test('sends: a send that reaches only machines the user trusts is none, and every other send is named as before', () => {
    const trustedHosts = ['homenas', '100.70.1.2', '192.168.0.10'];
    const trusting = (command, trustedSends = [], options = {}) => sendOf(command, { ...at, ...options, trustedHosts, trustedSends });
    // The brief's commands: no send with these trusted; with none trusted, the send they were. A copy from another
    // machine was none before either.
    for (const [command, today] of [
        ['ssh homenas ls /data', 'runs commands on homenas (ssh)'],
        ["ssh me@100.70.1.2 'rm -rf /tmp/x'", 'runs commands on 100.70.1.2 (ssh)'],
        ['scp f homenas:/data/x', 'copies files to homenas (scp)'],
        ['rsync -a homenas:/data/a ./', undefined],
        ['curl -X POST http://100.70.1.2:8000/v1/x', 'sends a POST to 100.70.1.2:8000/v1/x (curl)'],
    ]) {
        assert.equal(trusting(command), null, `trusted: ${command}`);
        assert.equal(sendOf(command, { ...at, trustedHosts: [] })?.what, today, `none trusted: ${command}`);
        assert.deepEqual(sendOf(command, { ...at, trustedHosts: [] }), sendOf(command, at), command);
    }
    // Another machine still sends; a command that also sends elsewhere names only that send; a push is a push.
    assert.equal(trusting('ssh gpu-01 hostname')?.what, 'runs commands on gpu-01 (ssh)');
    const skipped = [];
    assert.deepEqual(trusting('ssh homenas ls && curl -X POST https://example.com', skipped), { kind: 'request', program: 'curl', what: 'sends a POST to example.com (curl)' });
    assert.deepEqual(skipped.map((s) => s.program), ['ssh']);
    assert.equal(trusting('git push')?.what, 'pushes to its remote (git push)');
    assert.equal(trusting('git push homenas:/data/repo.git main')?.kind, 'push');

    // A name is matched on its machine alone, in any case: a user, a port, brackets and a path are left off.
    assert.deepEqual(['HomeNAS', 'me@100.70.1.2', 'nas:22', '[fd7a::1]:22', 'http://NAS:8080/x', 'fd7a::1', 'a b', '$NAS'].map(hostOf),
        ['homenas', '100.70.1.2', 'nas', 'fd7a::1', 'nas', 'fd7a::1', '', '']);
    for (const command of ['ssh HOMENAS ls', 'ssh -p 2222 -l root homenas ls', 'ssh ssh://me@homenas:22 ls', 'ssh -J 192.168.0.10 homenas ls',
        'ssh homenas zfs list -o name,used', 'ssh homenas ls -J jump.example.com', 'cat dump.sql | ssh homenas "cat > /data/dump.sql"', 'NAS=homenas; ssh "$NAS" df -h',
        'scp -P 2222 -r dist me@HomeNAS:/data/www', 'scp homenas:/data/a 192.168.0.10:/data/b', 'rsync -av dist/ homenas:/data/x --chown=root:root',
        'rsync -av -e "ssh -p 2222" dist/ homenas:/srv/www/', 'rsync -av dist/ rsync://homenas/www/', 'mosh homenas', 'autossh -M 0 -fN homenas',
        'curl -X POST http://HomeNAS:8000/v1/x', 'curl -sS -X POST -d @body.json 192.168.0.10:8080/v1/x', 'curl -x http://homenas:3128 -X POST http://100.70.1.2/x',
        'wget --post-data=x http://homenas/x', 'http POST homenas:8000/v1/x a=b', 'bash -c "ssh homenas ls"', './nas/deploy.sh', 'bash nas/deploy.sh']) {
        assert.equal(trusting(command), null, `trusted: ${command}`);
    }
    assert.equal(trusting('Invoke-RestMethod -Method Post -Uri http://192.168.0.10:8080/v1/x', [], { shell: 'pwsh' }), null);
    assert.equal(sendOf('ssh [fd7a::1] ls', { ...at, trustedHosts: ['[fd7a::1]:22'] }), null);
    // A script whose sends all reach a trusted machine says no more by its name; one that also sends elsewhere names that.
    assert.equal(sendOf('./nas/deploy.sh', at)?.what, 'runs ./nas/deploy.sh, which can copy files to homenas (rsync)');
    assert.equal(trusting('./nas/both.sh')?.what, 'runs ./nas/both.sh, which can send a POST to example.com/hook (curl)');
    assert.equal(sendOf('make -C m', { ...at, trustedHosts: ['host'] }), null);

    // Every machine on the way counts, and one it can't tell is never trusted: a jump host, a proxy, a host name of its
    // own, a config file or a command that picks where it goes, another URL, a name for a host, words added from elsewhere.
    for (const [command, what] of [
        ['ssh -J jump.example.com homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh homenas -J jump.example.com ls', 'runs commands on homenas (ssh)'],
        ['ssh -o ProxyJump=jump.example.com homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh -o "ProxyCommand nc relay.example.com 22" homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh -o HostName=other.example.com homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh -o PermitLocalCommand=yes -o LocalCommand="curl -d @x https://example.com" homenas', 'runs commands on homenas (ssh)'],
        ['ssh -F ./ssh_config homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh -S /tmp/shared homenas ls', 'runs commands on homenas (ssh)'],
        ['ssh -W example.com:22 homenas', 'runs commands on homenas (ssh)'],
        ['ssh homenas.example.com ls', 'runs commands on homenas.example.com (ssh)'],
        ['ssh "$HOST" ls', 'runs commands on $HOST (ssh)'],
        ['mosh --ssh="ssh -J jump.example.com" homenas', 'runs commands on homenas (mosh)'],
        ['AUTOSSH_PATH=./fake-ssh autossh -M 0 homenas', 'runs commands on homenas (autossh)'],
        ['scp f homenas:/data/x example.com:/y', 'copies files to example.com (scp)'],
        ['scp f homenas:/data/x -i example.com:/y', 'copies files to example.com (scp)'],
        ['scp -S ./fake-ssh f homenas:/data/x', 'copies files to homenas (scp)'],
        ['scp -o ProxyJump=jump.example.com f homenas:/data/x', 'copies files to homenas (scp)'],
        ["rsync -e 'ssh -J jump.example.com' f homenas:/data/x", 'copies files to homenas (rsync)'],
        ["rsync -e 'ssh example.com' f homenas:/data/x", 'copies files to homenas (rsync)'],
        ["RSYNC_RSH='nc example.com 22' rsync f homenas:/data/x", 'copies files to homenas (rsync)'],
        ['curl -x http://proxy.example.com:8080 -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl --socks5-hostname proxy.example.com:1080 -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['HTTPS_PROXY=http://proxy.example.com:8080 curl -X POST https://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['export ALL_PROXY=socks5://proxy.example.com:1080; curl -X POST https://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['CURL_HOME=. curl -X POST https://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl -X POST http://homenas@example.com/x', 'sends a POST to example.com/x (curl)'],
        ["curl -X POST 'http://example.com\\@homenas/x'", 'sends a POST to homenas/x (curl)'],
        ['curl -X POST http://homenas/x http://example.com/y', 'sends a POST to homenas/x (curl)'],
        ["curl -X POST 'http://{homenas,example.com}/x'", 'sends a POST to {homenas,example.com}/x (curl)'],
        ['curl --resolve homenas:80:203.0.113.9 -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl --connect-to homenas:80:example.com:80 -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl --unix-socket /var/run/docker.sock -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl -K curl.cfg -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['curl -X POST --url @urls.txt', 'sends a POST to urls.txt (curl)'],
        ['curl -X POST http://homenas.example.com/x', 'sends a POST to homenas.example.com/x (curl)'],
        ['curl -X POST http://100.70.1.2.nip.io/x', 'sends a POST to 100.70.1.2.nip.io/x (curl)'],
        ['wget -e use_proxy=on -e http_proxy=proxy.example.com:8080 --post-data=x http://homenas/x', 'sends a POST to homenas/x (wget)'],
        ['wget -i urls.txt --post-data=x http://homenas/x', 'sends a POST to homenas/x (wget)'],
        ['http --proxy=http:http://proxy.example.com:8080 POST homenas:8000/v1/x a=b', 'sends a POST to homenas:8000/v1/x (http)'],
        ['xargs curl -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['torsocks ssh homenas ls', 'runs commands on homenas (ssh)'],
        ['proxychains4 curl -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['op run -- curl -X POST http://homenas/x', 'sends a POST to homenas/x (curl)'],
        ['rsh homenas ls', 'runs commands on homenas (rsh)'],
    ]) {
        const left = [];
        assert.equal(trusting(command, left)?.what, what, command);
        assert.deepEqual(left, [], command);
    }
    assert.equal(trusting("$env:HTTPS_PROXY = 'http://proxy.example.com:8080'; Invoke-RestMethod -Method Post -Uri http://homenas/x", [], { shell: 'pwsh' })?.what,
        'sends a POST to homenas/x (invoke-restmethod)');
    // The machines a send reaches are for this check alone.
    assert.equal(Object.hasOwn(trusting('ssh gpu-01 hostname'), 'hosts'), false);
    assert.equal(Object.hasOwn(sendOf('ssh gpu-01 hostname', at), 'hosts'), false);

    // Code: the command lines it runs count the same way; its own web requests still ask.
    const code = (text, trustedSends = []) => codeSendOf(text, { depth: 0, cwd: '/w', read: at.read, trustedHosts, trustedSends }, 'run_code');
    const ran = [];
    assert.equal(code("import subprocess\nsubprocess.run(['ssh', 'homenas', 'ls', '/data'])", ran), null);
    assert.deepEqual(ran.map((s) => s.program), ['ssh']);
    assert.equal(code("import subprocess\nsubprocess.run(['ssh', 'homenas', 'ls'])\nsubprocess.run('curl -X POST https://example.com/x', shell=True)")?.what, 'runs code that sends a POST to example.com/x (curl)');
    assert.equal(code("import subprocess\nsubprocess.run(['ssh', 'gpu-01', 'ls'])")?.what, 'runs code that runs commands on gpu-01 (ssh)');
    assert.equal(code("import requests\nrequests.post('http://homenas:8000/v1/x', json={})")?.what, 'runs code that sends a POST (run_code)');
});
