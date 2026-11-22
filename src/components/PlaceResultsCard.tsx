import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Clock, ExternalLink, Footprints, ImageOff, Languages, MapPin, Navigation, Star, TriangleAlert } from 'lucide-react'
import { isServablePath, mediaUrl } from '../lib/media'
import { parsePlacesBlock, type Place, type PlacePhoto, type PlacesBlock } from '../lib/places'

/** 1 200 m -> "1.2 km"; below that, meters. */
function distanceText(t: TFunction, meters: number): string {
  if (meters >= 995) {
    const km = (meters / 1000).toFixed(1).replace(/\.0$/, '')
    return t('places.distanceKm', { km })
  }
  return t('places.distanceMeters', { meters: Math.round(meters) })
}

function durationText(t: TFunction, seconds: number): string {
  if (seconds < 60) return t('places.durationShort')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('places.durationMinutes', { minutes })
  return t('places.durationHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/** A supplied date string, formatted in the interface language; anything unparsable stays out. */
function dateText(language: string, value: string | undefined): string {
  if (!value) return ''
  try {
    const time = Date.parse(value)
    if (Number.isNaN(time)) return ''
    return new Date(time).toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

/** Local MEDIA photo, or a neutral placeholder. A remote path never becomes an image source. */
function PlacePhotoView({ photo, name, profile, version }: { photo: PlacePhoto | undefined; name: string; profile: string; version: string }) {
  const { t } = useTranslation()
  const [failed, setFailed] = useState(false)
  const servable = Boolean(photo && isServablePath(photo.path))
  return (
    <figure className="place-photo">
      {photo && servable && !failed
        ? <img src={mediaUrl(profile, photo.path, version)} alt={t('places.photoAlt', { name })} onError={() => setFailed(true)} />
        : <span className="place-photo-fallback" role="img" aria-label={t('places.photoUnavailable')}><ImageOff size={22} aria-hidden="true" /></span>}
      {photo && <figcaption>{photo.source_url
        ? <a href={photo.source_url} target="_blank" rel="noreferrer noopener">{t('places.photoCredit', { attribution: photo.attribution })}</a>
        : t('places.photoCredit', { attribution: photo.attribution })}</figcaption>}
    </figure>
  )
}

function PlaceCard({ place, profile, version }: { place: Place; profile: string; version: string }) {
  const { t, i18n } = useTranslation()
  const fetched = dateText(i18n.language, place.source.fetched_at)
  const distance = place.distance
  const opening = place.opening
  const feature = (label: string, value: boolean | null) => (
    <span className={`place-feature ${value === null ? 'is-unknown' : value ? 'is-yes' : 'is-no'}`}>
      {label}: {value === null ? t('places.featureUnknown') : value ? t('places.featureYes') : t('places.featureNo')}
    </span>
  )
  return (
    <article className="place-card" aria-label={t('places.cardLabel', { name: place.name })}>
      <PlacePhotoView photo={place.photo} name={place.name} profile={profile} version={version} />
      <div className="place-card-body">
        <header className="place-card-header">
          <strong className="place-name">{place.name}</strong>
          <span className="place-category">{place.category}</span>
        </header>
        {place.address && <p className="place-address"><MapPin size={13} aria-hidden="true" />{place.address}</p>}
        {(distance || opening || place.features) && (
          <div className="place-facts">
            {distance && (
              <span className="place-fact">
                <Footprints size={13} aria-hidden="true" />
                {distanceText(t, distance.meters)}
                {distance.seconds !== undefined && <><span className="place-fact-sep">·</span><Clock size={12} aria-hidden="true" />{durationText(t, distance.seconds)}</>}
                <span className={`place-distance-kind ${distance.kind === 'straight_line' ? 'is-straight' : ''}`}
                  title={distance.kind === 'straight_line' ? t('places.straightLineNote') : undefined}>
                  {distance.kind === 'straight_line' && <TriangleAlert size={11} aria-hidden="true" />}
                  {distance.kind === 'straight_line' ? t('places.straightLine') : t('places.route')}
                </span>
              </span>
            )}
            {opening && (
              <span className={`place-open is-${opening.status}`}>
                <span className="place-open-dot" aria-hidden="true" />
                {opening.label}
              </span>
            )}
            {place.features && (
              <span className="place-features">
                {feature(t('places.wifi'), place.features.wifi)}
                {feature(t('places.power'), place.features.power_outlets)}
              </span>
            )}
          </div>
        )}
        {place.rating && (
          <div className="place-rating" title={place.rating.source}>
            <Star size={13} aria-hidden="true" />
            <strong>{place.rating.value}</strong>
            <span>{t(place.rating.count === 1 ? 'places.ratingOne' : 'places.ratingCount', { count: place.rating.count })}</span>
          </div>
        )}
        {place.reviews && place.reviews.length > 0 && (
          <ul className="place-reviews">
            {place.reviews.map((review, index) => {
              const date = dateText(i18n.language, review.published_at)
              return (
                <li key={index} className="place-review">
                  <div className="place-review-meta">
                    {review.author && <span className="place-review-author">{t('places.reviewBy', { author: review.author })}</span>}
                    {review.rating !== undefined && <span className="place-review-stars"><Star size={11} aria-hidden="true" />{review.rating}</span>}
                    {date && <time>{date}</time>}
                    {review.url
                      ? <a className="place-review-source" href={review.url} target="_blank" rel="noreferrer noopener">{review.source}</a>
                      : <span className="place-review-source">{review.source}</span>}
                  </div>
                  <p className="place-review-text">{review.text}</p>
                  {review.translation && (
                    <p className="place-review-translation"><Languages size={12} aria-hidden="true" /><span>{t('places.translation')}</span>{review.translation}</p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <footer className="place-card-footer">
          <a className="place-directions" href={place.directions_url} target="_blank" rel="noreferrer noopener">
            <Navigation size={13} aria-hidden="true" />{t('places.directions')}<ExternalLink size={12} aria-hidden="true" />
          </a>
          <span className="place-source">
            {place.source.url
              ? <a href={place.source.url} target="_blank" rel="noreferrer noopener">{t('places.source', { name: place.source.name })}</a>
              : t('places.source', { name: place.source.name })}
            {fetched && ` · ${fetched}`}
          </span>
        </footer>
      </div>
    </article>
  )
}

export function PlaceResultsCard({ block, profile, version }: { block: PlacesBlock; profile: string; version: string }) {
  const { t } = useTranslation()
  return (
    <section className="place-results" aria-label={t('places.resultsLabel')}>
      <header className="place-results-title">{t('places.resultsLabel')}</header>
      {block.warnings.length > 0 && (
        <ul className="place-warnings">
          {block.warnings.map((warning, index) => (
            <li key={index}><TriangleAlert size={12} aria-hidden="true" />{warning}</li>
          ))}
        </ul>
      )}
      {block.places.map((place) => <PlaceCard key={place.id} place={place} profile={profile} version={version} />)}
      {block.attributions.length > 0 && (
        <div className="place-attributions">
          <span>{t('places.attributionsLabel')}</span>
          {block.attributions.map((attribution, index) => <span key={index}>{attribution}</span>)}
        </div>
      )}
    </section>
  )
}

/**
 * A `hermes-places` fence of the thread. While streaming, or when the JSON does not satisfy
 * the contract, the block stays inert: it renders as the plain code the bot wrote.
 */
export function PlacesBlock({ source, profile, version, streaming }: { source: string; profile: string; version: string; streaming: boolean }) {
  const block = streaming ? null : parsePlacesBlock(source)
  if (!block) return <pre><code>{source}</code></pre>
  return <PlaceResultsCard block={block} profile={profile} version={version} />
}
