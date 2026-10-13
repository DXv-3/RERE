# Browser on your phone

Each thread in the phone app has a browser. Open a thread and tap the globe in its header. Type an
address and tap Go. The bottom bar has Back, Forward, Reload (Stop while a page loads) and Close
Tab, and **+** opens another tab. Pages stay loaded when you leave the Browser screen, so you can
go back to the conversation and return to the same page.

## Agents use the same browser

While the app is open, your phone counts as a browser for every server it is connected to. An
agent's browser tools (`preview_open`, `preview_snapshot`, `preview_click`, `preview_type` and the
others) can run on the phone. Each thread's agent gets that thread's tabs: a page the agent opens
appears in the Browser screen, and a page you open is the one the agent sees.

When the desktop app is connected too, the server picks one browser for an agent's first request:
the one showing that thread's page, then one that has it open, then the one you used most
recently. The agent's later requests go to the same browser, so a sign-in or a half-filled form
does not jump between devices.

A snapshot taken on the phone has no picture. Agents get the page's text and its buttons, links
and fields instead. The phone cannot resize the page, record it, or list its network requests; an
agent working in the phone's browser gets an error for those, and needs a new session on the
desktop to use them.

## Addresses like localhost

A page in the phone's browser runs on the phone, so `localhost` would mean the phone itself. The
app swaps `localhost` and `127.0.0.1` for the address it uses to reach your CodeWrench machine.
That way `localhost:5173` opens the dev server running on that machine. This works when the phone
reaches the machine over your local network or Tailscale. If the app reaches the server through an
address that only works on that machine, a dev server cannot be reached; the browser says so, and
a public address still works.

An address without `http://` or `https://` opens with `https://`, except `localhost` addresses,
which open with `http://`. When you edit the address of the page you are on, its scheme is kept.
