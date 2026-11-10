import { mediaPreviewText } from './media'
import { i18n, locale } from '../i18n'

export function relativeTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const diff = date.getTime() - Date.now()
  const absolute = Math.abs(diff)
  if (absolute < 60_000) return diff >= 0 ? i18n.t('time.now') : i18n.t('time.justNow')
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ]
  const [size, unit] = units.find(([size]) => absolute >= size) || [60_000, 'minute']
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(diff / size), unit)
}

export function shortTime(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date)
  }
  const days = (today.getTime() - date.getTime()) / 86_400_000
  if (days < 7) return new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(date).replace('.', '')
  return new Intl.DateTimeFormat(locale(), { day: '2-digit', month: '2-digit' }).format(date)
}

export function messageDay(value: string | null) {
  if (!value) return ''
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(value))
}

export function dateTime(value: string | null) {
  if (!value) return i18n.t('time.notScheduled')
  return new Intl.DateTimeFormat(locale(), {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

export function cleanPreview(value: string) {
  const withoutMail = value
    .replace(/(`{3,})hermes-mail-approved[\s\S]*?(\1|$)/g, ` ${i18n.t('time.mailApproved')} `)
    .replace(/(`{3,})hermes-mail[\s\S]*?(\1|$)/g, ` ${i18n.t('time.mailDraft')} `)
  return mediaPreviewText(withoutMail.replace(/```[\s\S]*?```/g, ` ${i18n.t('time.code')} `))
    .replace(/\[Image\]/g, i18n.t('time.image'))
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
