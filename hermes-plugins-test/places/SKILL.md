---
name: places
description: Find nearby real-world places (cafes, pharmacies, parks, hotels, …) with walking distance and directions. Use when the user asks what is near a location, where to eat/drink/buy something nearby, or how far a venue is on foot.
---

# places

Turn "what's near X" questions into structured, sourced answers. The
`places_nearby` tool queries OpenStreetMap (Overpass) with a local Overture
fallback, computes a pedestrian route (local Valhalla, public Valhalla, then
OSRM, then an honest straight-line estimate), and returns up to 3 places in a
shared JSON contract.

## Resolve the origin first

Use coordinates supplied by a location pin or an explicitly saved user location.
For "near me" or "near home", do not guess: if no explicit location is recorded,
ask for a pin or a neighborhood. For a named public place, geocode it once with
the existing maps skill, then pass the returned coordinates to `places_nearby`.
Respect the Nominatim public-service policy and cache geocoding results.

For cafés within a 10–15 minute walk, start with `radius: 1500` and `limit: 3`.
Reduce the radius for a strict nearby request. Wi-Fi, power and laptop suitability
are unknown unless the returned `features` explicitly source them.

## Using the tool

Call `places_nearby` with:

- `category` (required): `cafe`, `restaurant`, `bar`, `bakery`, `pharmacy`,
  `supermarket`, `convenience_store`, `atm`, `bank`, `hospital`, `clinic`,
  `park`, `hotel`, `library`, `museum`, `fuel`, `gym`
- `latitude`, `longitude` (required)
- optional `radius` (meters, 50–2000), `limit` (max 3),
  `filters.name_contains`, `filters.wheelchair`

`places_doctor` checks plugin health; pass `probe: true` for short live
network probes (Overpass plus the local and public Valhalla routing
endpoints) when results look wrong. A `degraded` note means the local
Valhalla is silent but public routing still works.

## Presenting results

**Compatible clients** (anything that renders `hermes-places` blocks): relay
the tool result **verbatim** — it is already a fenced block:

    ```hermes-places
    { ... }
    ```

Do not reformat, truncate or re-order the JSON; the block is the contract.

**Other channels** (plain chat, Markdown surfaces): present **three Markdown
entries at most**, one per place, each like:

1. **Name** — address (if present); *Category*.
   Walking distance (or "straight-line estimate" when the tool warns that no
   route was available); [walking directions](directions_url). The directions
   link carries the destination only: it opens with the user's own GPS
   position as the start, so the location the user shared is not re-exposed
   inside the link.

Mention cached or fallback data when the block's `warnings` say the result
came from the last-good cache, an Overture extract, or straight-line
estimates. Carry the provider attribution line(s) from `attributions`, and
per place relay `source.name` verbatim — it is the verifiable source line
(e.g. `Overture Maps (Foursquare, Meta)` names the datasets behind a local
extract record).

## Honesty rules

- Never invent opening hours, ratings, reviews, photos or amenities. Fields
  absent from the contract are unknown — say "unknown", not a guess.
- A `straight_line` distance has no walking time; do not estimate one.
- Zero results and provider failures are different messages from the tool:
  widen the radius or change category for the former; retry later or run
  `places_doctor` for the latter.
