# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Visitors on foot.** Tourists and locals walking a city route in Nizhny Novgorod with a phone. They use it one-handed, outdoors, often in bright sun, on the move, sometimes with gloves, with headphones in and the phone in a pocket between stops. Their attention is on the street, not the screen. Connectivity is mobile and can be patchy. Many open the guide once, from a link, without installing anything.
- **Editors.** Staff of the «Наука в каждом шаге» project who create and publish routes and points (text, coordinates, trigger radius, audio, photos) in the separate admin app (`audioguide-admin`). They work at a desk on a laptop.

## Product Purpose

It is a city audio guide on the web. A visitor picks a route, and the guide leads them from stop to stop. When they reach a stop, its story starts on its own (Автозвук, triggered by a geofence). Success means the visitor finishes a walk without needing to look at the phone at every step and hears every story in full.

## Operating Context

Use scenes:

1. **Choosing a route** at home, in a café or at the starting point. The visitor browses the list, opens a route and listens to the intro.
2. **Starting the walk.** They grant geolocation, turn on Автозвук and put the phone away.
3. **Walking.** They glance at the phone for the next stop, the distance and the direction. The map frames «me + next stop». The walk panel answers «where next, how far, is the sound on?».
4. **At a stop.** The story plays by itself, and the point card shows a photo and text.
5. **Free exploring.** The map shows all points, and the visitor opens any of them by hand, with no route.
6. **Editing.** In the admin app, editors place points on a map, attach media and order the stops of a route.

A stop that has "triggered" (the geofence fired) is not the same as a stop that was "listened" (the story reached at least 80 % or the end). Only listened stops are marked «Прослушано».

## Capabilities and Constraints

- **No build step.** Native ES modules, plain CSS and static files. Nothing to compile or bundle.
- **Strict CSP.** No inline scripts or handlers, and no `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `onclick=` or `alert(`. DOM is built with `el()` from `js/dom.js`. Fonts are self-hosted. Media URLs are validated (`isSafeImageUrl` / `isSafeAudioUrl`).
- **Local media.** Audio and images are served by our own backend under `/media/…` with server-generated filenames. There is no third-party media CDN.
- **Yandex Maps 2.1 display only.** The API key covers map display. The paid Yandex router and geocoder are not used, because they cost too much. «Как дойти» falls back to a `yandex.ru/maps` link.
- **Geolocation and autoplay.** Audio must be unlocked inside a user gesture. Geolocation can be denied, and the guide must stay usable without it (open points by hand).
- **Demo mode.** `?demo=1` loads `dev/guide.sample.json`: synthetic data with flat SVG placeholders in `dev/placeholders/`. It is not deployed.
- **Responsive.** On phones the app has tabs (Маршруты / Карта / Настройки). From 960 px up, the list is on the left and the map on the right. It must work down to 320 px wide.

## Brand Commitments

- **The pinned visual world is science-step.ru.** On 2026-10-01 the owner explicitly asked for the guide to be styled after science-step.ru (the «Наука в каждом шаге» project; the routes are its «Научные маршруты»). That site is the binding reference. The guide is flat: a grey concrete ground, black Inter Tight, zero radii and 1 px ink rules, with flat highlighter bars in coral, lime and blue. There are no gradients, shadows or glass.
- **Voice:** short, direct, neutral imperative («Разрешите…», «Нажмите…»). Russian UI.

## Evidence on Hand

- Real route and point content lives in the backend database. It is not in this repo.
- `dev/guide.sample.json` is **synthetic demo data** (`"_note": "synthetic demo data"`). Its images are placeholders, and its audio consists of stock sample tracks. Never present it as real content, and never reintroduce stock photos of unrelated places.
- There are no photographs of the actual stops in the repo yet.

## Product Principles

1. **Eyes on the street.** Every walking-mode screen must answer «where next, how far, is the sound on?» at a glance, one-handed.
2. **Works when things fail.** No geolocation, no audio unlock or no network must still leave a usable guide.
3. **Honest state.** «Прослушано» means that the story was heard. Progress is never inflated by a mere trigger.
4. **Don't fight the user.** Auto-behaviour (framing the map, playing audio) steps aside as soon as the visitor takes over.

## Accessibility & Inclusion

- It is used outdoors in sunlight, so text contrast must be at least AA (4.5:1). Touch targets are at least 44 px. Critical text must not be truncated at 320–375 px.
- Screen-reader announcements are made for the next stop and for the Автозвук state. `prefers-reduced-motion` is respected.
