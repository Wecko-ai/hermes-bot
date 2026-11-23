import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoomMember } from '../lib/rooms'
import type { RoomRoutingMode } from '../lib/room-routing'

interface RoomRoutingDialogProps {
  mode: RoomRoutingMode
  leadId: string
  members: RoomMember[]
  open: boolean
  saving: boolean
  onClose: () => void
  onSave: (mode: RoomRoutingMode, leadId: string) => void
}

const MODES: RoomRoutingMode[] = ['mentions', 'everyone', 'facilitator']

export function RoomRoutingDialog({ mode, leadId, members, open, saving, onClose, onSave }: RoomRoutingDialogProps) {
  const { t } = useTranslation()
  const [draftMode, setDraftMode] = useState(mode)
  const [draftLead, setDraftLead] = useState(leadId || members[0]?.member_id || '')
  if (!open) return null
  const hint = draftMode === 'everyone' ? t('roomRouting.hintEveryone') : draftMode === 'mentions' ? t('roomRouting.hintMentions') : t('roomRouting.hintFacilitator')
  return (
    <div className="room-routing-dialog" role="dialog" aria-label={t('roomRouting.title')}>
      <h3>{t('roomRouting.title')}</h3>
      <div className="settings-segments" role="radiogroup" aria-label={t('roomRouting.title')}>
        {MODES.map((item) => (
          <button key={item} type="button" role="radio" aria-checked={draftMode === item} className={draftMode === item ? 'is-active' : ''} onClick={() => setDraftMode(item)}>
            {t(`roomRouting.${item === 'facilitator' ? 'facilitator' : item}`)}
          </button>
        ))}
      </div>
      {draftMode === 'facilitator' && (
        <label className="room-routing-lead">{t('roomRouting.pickLead')}
          <select value={draftLead} onChange={(event) => setDraftLead(event.target.value)}>
            {members.map((member) => <option key={member.member_id} value={member.member_id}>{member.display_name || member.handle || member.member_id}</option>)}
          </select>
        </label>
      )}
      <p className="readonly-note">{hint}</p>
      <div className="room-routing-actions">
        <button type="button" onClick={onClose}>{t('newRoom.cancel')}</button>
        <button type="button" className="pill-button" disabled={saving || (draftMode === 'facilitator' && !draftLead)} onClick={() => onSave(draftMode, draftLead)}>{t('roomRouting.save')}</button>
      </div>
    </div>
  )
}