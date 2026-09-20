<h1 align="center">Homebridge SwitchBot — Matter fork</h1>

<p align="center">
    <a href="https://www.npmjs.com/package/homebridge">
        <img src="https://img.shields.io/badge/powered%20by-homebridge-blue" alt="powered by homebridge">
    </a>
    <a href="#infrared-remotes-brought-back">
        <img src="https://img.shields.io/badge/infrared-supported-brightgreen" alt="infrared remotes supported">
    </a>
    <a href="#both-ecosystems-at-once">
        <img src="https://img.shields.io/badge/HAP%20%2B%20Matter-together-brightgreen" alt="HAP and Matter together">
    </a>
    <a href="LICENSE">
        <img src="https://img.shields.io/badge/license-ISC-lightgrey" alt="license ISC">
    </a>
</p>

---

This is a fork of [`OpenWonderLabs/homebridge-switchbot`](https://github.com/OpenWonderLabs/homebridge-switchbot),
which brings SwitchBot devices into HomeKit. Everything that plugin does, this one does.

The fork exists because of three things: version 5 dropped infrared remotes, HomeKit and Matter could not
be had at the same time, and what one ecosystem knew the other did not.

## Infrared remotes brought back

An infrared remote is a code the hub blasts at an appliance; nothing answers, so a remote has no state to
read — only the state the plugin remembers having sent, which is what the SwitchBot app shows too. Remotes
are cloud-only and never appear in discovery, so commands go straight to the cloud API rather than through
the device manager, which would look for a device that is not there.

What a remote was last told survives a restart, because the alternative is every restart claiming the
lights went off.

## Both ecosystems at once

HomeKit speaks HAP; everything else in a home — Alexa, SmartThings, Aqara — sees it over Matter. The
devices are published both ways rather than one instead of the other, and both halves drive **the same
device object**: curtains, blinds, bots, plugs, lights, meters and infrared remotes.

That last part sounds like a detail and is the whole thing. The two platforms load their devices at the
same time, and while the register of shared devices was written only after a device finished being built,
both halves looked, found nothing, and each ended up with its own object — so each ecosystem had its own
idea of what the garland was doing, and neither ever heard about the other's commands. The curtains
escaped it by luck, being read back from the cloud either way.

Beyond that: each half reports changes rather than waiting to be asked, a command from either side is
followed by reading the device back a few times over the next forty seconds, and a command carrying the
value this plugin has just reported is ignored — that is a controller keeping its own attributes in step,
not a person pressing anything.

## Cloud by default, Bluetooth on request

Upstream depends on `node-switchbot`, which carries a native Bluetooth stack compiled from C++ wherever
the plugin is installed — minutes of it on a Raspberry Pi, on every install and every update. With a hub,
none of it is needed: the SwitchBot cloud API is a signed HTTPS request, and this fork speaks it directly.

To reach devices over Bluetooth instead — useful without a hub — install the library alongside the plugin
and set `enableBLE: true`:

```
npm --prefix /var/lib/homebridge install node-switchbot
```

Without it, `enableBLE` is ignored and everything goes through the cloud.

## Also fixed

- A closed curtain reports 99 rather than 100: the motor stops where its calibration says, not at a round
  number. Reported as it is, a closed curtain shows up as "1% open" in every app, and a controller just
  told the curtain was closed watches it reopen a minute later. The last couple of percent at either end
  are rounded off.
- `open` and `close` were the Bluetooth library's words for a curtain; the cloud calls them `turnOn` and
  `turnOff` and refuses anything else, so opening a curtain from a Matter controller failed outright.

## Installation

```
npm --prefix /var/lib/homebridge install github:lirik44/homebridge-switchbot
```

The package is published under a scoped name, so it lives alongside the upstream plugin rather than over
it. Enable Matter for the child bridge this plugin runs in to have the same devices reach Matter apps.

## Development

```
npm install
npm test
npm run lint
```

## Credits

- [OpenWonderLabs/homebridge-switchbot](https://github.com/OpenWonderLabs/homebridge-switchbot) — the
  plugin this fork is based on
- [OpenWonderLabs/node-switchbot](https://github.com/OpenWonderLabs/node-switchbot) — the Bluetooth
  library, now optional
- [homebridge/homebridge](https://github.com/homebridge/homebridge) — Homebridge, and its Matter support

## License

ISC, same as the upstream project.
