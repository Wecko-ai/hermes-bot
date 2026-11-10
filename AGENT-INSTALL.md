# Install HermesBot with your agent

This page is written for an agent: any assistant that can run shell commands on your Mac.

**If you are a person**, give your agent this message:

> Read https://raw.githubusercontent.com/Wecko-ai/hermes-bot/main/AGENT-INSTALL.md and follow it, step by step, to install HermesBot on this Mac.

The agent checks your Mac, builds the app, tries it in demo mode and tells you whether HermesBot can sign in to your Hermes. It asks you before it touches your Hermes or your Applications folder. Two things stay yours: the password, which you type in the app and nowhere else, and any change to how your Hermes is reached.

**If you are the agent**, the rest of this page is for you.

## Rules

They hold for the whole installation.

- Ask the person before each of these: restarting the Hermes gateway, changing a Hermes setting, copying an app into `/Applications`, installing Node.js or any other tool.
- Never use `sudo`. Nothing here needs it.
- Never ask for a password in the chat, never read one from a file, never write one anywhere. The person types their Hermes password in the HermesBot window.
- Never change the address Hermes listens on, and never give it a public URL. Step 4 says why.
- Never send a message to a bot to test the app: a message starts a model turn, and it can cost money.
- Never edit a Hermes profile.
- Stop a process by the process ID you noted when you started it, never by name.
- Run every check. If one fails, stop and report what you saw. Do not work around it.

## 1. Check the Mac

```bash
sw_vers -productVersion   # macOS version
uname -m                  # must print arm64
node --version            # must be v22 or later
npm --version
git --version
df -h "$HOME" | tail -1   # about 1 GB free is needed
```

- Not macOS, or not `arm64`: stop. The packaged app is for Apple silicon Macs.
- Node.js missing or older than 22: say so, and ask the person how they want to install it. Do not install it without a yes.

## 2. Get the code

```bash
git clone https://github.com/Wecko-ai/hermes-bot.git "$HOME/hermes-bot"
cd "$HOME/hermes-bot"
npm ci
```

- If `$HOME/hermes-bot` already exists, do not overwrite it. Ask the person to choose: another folder, or an update of that copy (see "Later").
- `npm ci` may print `npm warn install-scripts`. That is expected. It succeeded if it exits with code 0.
- If the clone or `npm ci` fails, stop and report the error.

The steps below say `$HOME/hermes-bot`. Use the folder you cloned into.

## 3. Try the demo

The demo runs on fictional data. It needs no Hermes and never calls a model.

First check that port 4330 is free:

```bash
nc -z 127.0.0.1 4330 >/dev/null 2>&1 && echo taken || echo free
```

If it prints `taken`, use another port, such as 4340, everywhere in this step.

Start the server in the background and keep its process ID:

```bash
cd "$HOME/hermes-bot"
NODE_ENV=development PORT=4330 node server/index.mjs > /tmp/hermesbot-demo.log 2>&1 &
echo $! > /tmp/hermesbot-demo.pid
```

Wait until it answers, then check that it is HermesBot:

```bash
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:4330/api/health && break; sleep 1; done
curl -s http://127.0.0.1:4330/api/health                                    # {"ok":true,"service":"hermes-bot"}
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:4330/?demo=1'    # 200
```

The person can open `http://127.0.0.1:4330/?demo=1` in a browser to look at the app. When they are done, stop the server:

```bash
kill "$(cat /tmp/hermesbot-demo.pid)"
```

If a check fails, read `/tmp/hermesbot-demo.log`, stop the server and report.

## 4. Check Hermes

HermesBot is a window on [Hermes Agent](https://github.com/NousResearch/hermes-agent). It talks to the Hermes gateway, by default on this Mac at port 9120.

```bash
hermes --version
curl -s -m 5 http://127.0.0.1:9120/api/status
```

If `hermes` is not found, stop after the demo: HermesBot needs Hermes Agent, and installing it is the person's choice.

Otherwise, read `auth_required` and `auth_providers` in the answer of the second command, and follow the matching case.

**No answer.** Ask the person where their gateway runs.

- On another port or another machine: stop here and point them to "Connect it to Hermes" in the README. It lists the settings for that.
- On this Mac, with the default port: the gateway is not running, or its Webapp is off. You cannot tell whether a bot is working, so ask the person to confirm that none is. With their yes:

  ```bash
  hermes config set webapp.enabled true
  hermes gateway restart
  ```

  Then run the check again. If you are a Hermes bot yourself, do not run these two commands from your own turn: the restart would stop you. Ask the person to run them.

**`"auth_required": true`, with `"basic"` in `auth_providers`.** Hermes has a username and password sign-in. HermesBot can connect. Go to step 5.

**`"auth_required": false`.** This is the default local setup of Hermes: no password, the browser is signed in with a one-use link. HermesBot only signs in with a username and password, so it cannot connect to this setup yet.

- Do not change the address Hermes listens on, and do not give it a public URL, to get a password page. Either one makes Hermes reachable from outside this Mac. That choice belongs to the person, with the Hermes documentation open ("Web Dashboard", section "Authentication").
- If the person wants the app anyway, go to step 5. The app opens and the demo works; signing in fails until their Hermes has a username and password sign-in.
- Say this plainly in your report.

**`"auth_required": true`, without `"basic"`.** Hermes uses another sign-in, such as OAuth. HermesBot cannot use it. Report it, and stop after the demo unless the person wants the app anyway.

## 5. Build and install the app

```bash
cd "$HOME/hermes-bot"
npm run pack
test -s release/mac-arm64/HermesBot.app/Contents/Resources/app.asar && echo built
```

- The build takes from ten seconds to a few minutes and prints a long log. Warnings such as `author is missed` or `duplicate dependency references` are expected.
- It succeeded if `npm run pack` exits with code 0 and the last command prints `built`.
- The app is unsigned. Built on this Mac, it opens normally.

Ask before you install it. If `/Applications/HermesBot.app` already exists, say so, ask the person to quit HermesBot, and offer a backup copy first:

```bash
cp -R /Applications/HermesBot.app "$HOME/HermesBot.app.backup"   # only if they want one
```

With their yes, install and open:

```bash
rsync -a --delete release/mac-arm64/HermesBot.app/ /Applications/HermesBot.app/
open /Applications/HermesBot.app
```

The person signs in in the app window, with their Hermes username and password.

## 6. Report

Tell the person, in a few lines:

- what you installed, and where (the folder of the code, `/Applications/HermesBot.app`);
- the result of each check: the Mac, the demo, Hermes, the build;
- whether HermesBot can sign in to their Hermes, and if not, which case of step 4 applies;
- what you skipped because they said no.

## Later

- **Update.** Run `git pull`, `npm ci` and `npm run pack` in the folder of the code. If `git pull` refuses because files were changed there, stop and ask. Then follow the install part of step 5 again.
- **Remove.** With the person's yes, quit HermesBot and delete `/Applications/HermesBot.app`, the folder of the code and `~/Library/Application Support/HermesBot/`. That last folder holds their settings and their saved session: say so before you delete it. The app also keeps an encryption key in the macOS Keychain, which the person can remove in Keychain Access.
