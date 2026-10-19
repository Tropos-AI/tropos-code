# Phone access (Tailscale)

Phone access lets you open the dashboard on your phone, wherever you are, without putting it on the internet. Tropos
publishes the dashboard to your own [Tailscale](https://tailscale.com) network (your *tailnet*) with
`tailscale serve`, over HTTPS. Only devices signed in to your tailnet can reach it, and each one still has to log in
with a code. Tropos never uses Tailscale Funnel, which would make it public.

## Turn it on

1. Install the Tailscale app on this computer ([tailscale.com/download](https://tailscale.com/download)), open it and
   sign in.
2. Install Tailscale on your phone and sign in with the same account.
3. Turn on phone access, in any of these places:
   - `tcode onboard`, the Phone step;
   - the dashboard: Settings → Phone access;
   - the dashboard's Setup page.
4. Tropos shows the phone address (like `https://mac.tail1234.ts.net/`), a QR code for it and a 6-digit login code.
   Open the address on your phone (or scan the QR code) and type the code.

That's it: your phone stays logged in from then on.

### What Tropos runs

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

It uses HTTPS port 443 on your tailnet name, or 8443, or 10000, whichever isn't already served by something else, and
never changes a serve rule that isn't its own. When it had to pick another port it says so, and the address includes
it (`https://mac.tail1234.ts.net:8443/`). The tailnet name and port are kept in `~/.tropos/gateway.json` under
`remoteAccess`.

## Log in another phone or tablet

Any of these give a fresh 6-digit code (it works once, for 10 minutes):

```bash
tcode dashboard --code      # prints the phone address, a QR code and the code
```

- send `/login` to your Telegram bot (owner only, in your private chat);
- the dashboard: Settings → Phone access.

See who is logged in, and log devices out, in Settings → Channels & devices → Devices.

## Check it

```bash
tcode status      # the "phone" row shows the address
tcode doctor      # warns when Tailscale isn't running
```

## Turn it off

Settings → Phone access, turn it off. Tropos runs `tailscale serve --https=<port> off`, stops accepting the tailnet
name, and logs out the devices that only ever connected over it (a device you also used on this computer stays
logged in). If Tailscale can't be reached at that moment, Tropos remembers and retries when the gateway starts and
when `tcode doctor` runs.

## How it is protected

- The dashboard still listens on `127.0.0.1` only; `tailscale serve` forwards to it.
- Its `Host` and `Origin` checks accept the tailnet name only while phone access is on, and only a `*.ts.net` name.
- Every phone needs its own device login; being on the tailnet isn't enough.
- If Funnel is turned on for the port Tropos serves, Tropos refuses to continue until you turn Funnel off.

## Troubleshooting

- **"Tailscale isn't installed on this computer."** Install it from
  [tailscale.com/download](https://tailscale.com/download), sign in, and try again.
- **"Tailscale isn't running or isn't signed in."** Open the Tailscale app on this computer and sign in.
- **"Ports 443, 8443 and 10000 on your tailnet name are already served by something else."** Free one: see what is
  served with `tailscale serve status`.
- **"… is open to the whole internet (Tailscale Funnel)."** Run the `tailscale funnel --https=<port> off` command the
  message shows, then turn phone access on again.
- **The phone can't open the address.** Check that Tailscale is connected on the phone, with the same account, and
  that the gateway runs (`tcode status`).
- **The phone shows the login screen again.** It was logged out (phone access was turned off, or the device was
  revoked). Get a new code with `tcode dashboard --code` or `/login`.
