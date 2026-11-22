# Third-party notices

HermesBot is MIT-licensed (see `LICENSE`). It includes or follows the third-party work below. npm dependencies not listed here keep their own licenses, shipped in their packages.

## Provider logos

The SVG logos in `src/assets/providers/` are copied unchanged from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) 1.102.0, MIT License, Copyright (c) 2023 LobeHub. They only identify a provider in the model picker. The logos remain trademarks of their owners.

## Hermes Agent

HermesBot talks to the gateway of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT License, Copyright (c) 2025 Nous Research). Some rules, such as the parsing of `MEDIA:` lines and the `@mention` note, follow the behavior of Hermes Desktop. No Hermes code is bundled.

## Places and web data sources (optional plugins)

The optional generic plugins in `hermes-plugins/` use the free sources below. No data from them is bundled in this repository, and the plugins need no API key.

- **OpenStreetMap** data (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)), queried live through Overpass API demo endpoints or imported locally from an extract.
- **Overture Maps** data ([Overture Maps Foundation](https://overturemaps.org/), [CDLA-Permissive 2.0](https://cdla.dev/permissive-2-0/) or [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0), depending on the per-record source), imported locally.
- **[Valhalla](https://github.com/valhalla/valhalla)** (MIT License) for pedestrian routing, public demo endpoint or a local instance; **OSRM** as a fallback router.
- **[SearXNG](https://github.com/searxng/searxng)** (AGPL-3.0) as an optional self-hosted metasearch backend, and the **[ddgs](https://github.com/deedy5/ddgs)** package (MIT License) as the keyless failover backend. Both are optional runtime integrations, installed and run by the operator; nothing is bundled.
- **[Trafilatura](https://github.com/adbar/trafilatura)** as an optional, use-when-installed page extractor (not bundled; see its package for the license terms).
- Google Maps appears only as plain `https://www.google.com/maps/...` directions links produced by the plugin. There is no Google API client, no data exchange and no paid Google integration; "Google Maps" is a trademark of Google.

## Presentation film and README images

The film in `docs/readme/hermesbot-film.mp4` and the images in `docs/readme/` were made for this project. The film's music and voice were generated with ElevenLabs. The lettering uses the Outfit and JetBrains Mono typefaces (SIL Open Font License 1.1), rendered into the images. The provider logos shown in them are those listed under "Provider logos" above.

## Independent project

HermesBot is an independent project: it is not affiliated with, endorsed by or connected to Nous Research or any provider named in the app.
