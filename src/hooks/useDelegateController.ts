import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Bot, ModelOption } from '../types'
import type { ActiveChat, HermesClient } from '../lib/hermes'
import { DELEGATE_UNAVAILABLE, delegateMigrationTarget, isDelegateModel, loadDelegate, setDelegate, type DelegateState } from '../lib/delegate'
import { isAutoModel } from '../lib/auto-router'
import { useChatStore } from '../store/chat'

export function resolveDelegateTargetModel(
  chatModel: string,
  sessionModel: string | undefined,
  botModel: string | undefined,
  modelOptions: ModelOption[],
  botProvider?: string,
) {
  const model = chatModel && !isAutoModel(chatModel) && !isDelegateModel(chatModel)
    ? chatModel
    : (sessionModel && !isDelegateModel(sessionModel) ? sessionModel : (botModel || ''))
  const provider = modelOptions.find((o) => o.model === model)?.provider || (model === botModel ? botProvider : '') || ''
  return { model, provider }
}

interface DelegateControllerParams {
  client: HermesClient
  demo: boolean
  connected: boolean
  activeChat: ActiveChat | null
  chatModel: string
  selectedBot: Bot | undefined
  bots: Bot[]
  modelOptions: ModelOption[]
  defaultAutoPicker: () => string
  setChatModel: (model: string) => void
  applyOwnModelSwitch: (chat: ActiveChat, option: ModelOption) => Promise<void>
}

const chatKey = (chat: { profile: string; sessionId: string }) => `${chat.profile}\n${chat.sessionId}`

export function useDelegateController({
  client,
  demo,
  connected,
  activeChat,
  chatModel,
  selectedBot,
  bots,
  modelOptions,
  defaultAutoPicker,
  setChatModel,
  applyOwnModelSwitch,
}: DelegateControllerParams) {
  const [delegateView, setDelegateView] = useState<{ key: string; state: DelegateState } | null>(null)
  const [delegateBusy, setDelegateBusy] = useState(false)
  const [delegateError, setDelegateError] = useState('')
  const delegateMigrated = useRef(new Set<string>())

  const activeProfile = activeChat?.profile
  const activeSessionId = activeChat?.sessionId
  const activeSessionModel = activeChat?.model

  const targetModel = useMemo(
    () => resolveDelegateTargetModel(chatModel, activeSessionModel, selectedBot?.model, modelOptions, selectedBot?.provider),
    [chatModel, activeSessionModel, selectedBot?.model, selectedBot?.provider, modelOptions],
  )

  useEffect(() => {
    if (demo || !connected || !activeProfile || !activeSessionId) {
      setDelegateView(null)
      return
    }
    const target = {
      profile: activeProfile,
      sessionId: activeSessionId,
      model: targetModel.model,
      provider: targetModel.provider,
    }
    let live = true
    setDelegateError('')
    loadDelegate(client, target)
      .then((state) => { if (live) setDelegateView({ key: chatKey(target), state }) })
      .catch(() => { if (live) setDelegateView({ key: chatKey(target), state: DELEGATE_UNAVAILABLE }) })
    return () => { live = false }
  }, [client, demo, connected, activeProfile, activeSessionId, targetModel.model, targetModel.provider])

  // A chat that had picked the legacy Delegate sentinel: toggle on, then return to the bot's default model.
  useEffect(() => {
    const chat = activeChat
    if (!chat || !delegateView || delegateView.key !== chatKey(chat) || !delegateView.state.available) return
    if (!(isDelegateModel(chat.model) || isDelegateModel(chatModel)) || chat.running) return
    const key = delegateView.key
    if (delegateMigrated.current.has(key)) return
    delegateMigrated.current.add(key)
    const bot = bots.find((item) => item.slug === chat.profile) || selectedBot
    const target = bot ? delegateMigrationTarget(bot) : null
    void (async () => {
      try {
        const state = await setDelegate(client, { profile: chat.profile, sessionId: chat.sessionId, model: target?.model || targetModel.model, provider: target?.provider || targetModel.provider }, true)
        setDelegateView((value) => value?.key === key ? { key, state } : value)
        if (target && isDelegateModel(chat.model)) await applyOwnModelSwitch(chat, target)
        else if (isDelegateModel(useChatStore.getState().chatModel)) setChatModel(defaultAutoPicker() || target?.model || '')
      } catch (error) {
        setDelegateError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [activeChat, chatModel, delegateView, bots, selectedBot, client, targetModel.model, targetModel.provider, applyOwnModelSwitch, defaultAutoPicker, setChatModel])

  const toggleDelegate = useCallback(async (on: boolean) => {
    const chat = useChatStore.getState().activeChat
    if (!chat) return
    const key = chatKey(chat)
    setDelegateBusy(true)
    setDelegateError('')
    try {
      if (delegateView?.key === key && delegateView.state.available) {
        const state = await setDelegate(client, {
          profile: chat.profile,
          sessionId: chat.sessionId,
          model: targetModel.model,
          provider: targetModel.provider,
        }, on)
        setDelegateView({ key, state })
      }
      if (!on && (isDelegateModel(chat.model) || isDelegateModel(useChatStore.getState().chatModel))) {
        const bot = bots.find((item) => item.slug === chat.profile) || selectedBot
        const target = bot ? delegateMigrationTarget(bot) : null
        if (target) await applyOwnModelSwitch(chat, target)
      }
    } catch (error) {
      setDelegateError(error instanceof Error ? error.message : String(error))
    } finally {
      setDelegateBusy(false)
    }
  }, [delegateView, client, targetModel.model, targetModel.provider, bots, selectedBot, applyOwnModelSwitch])

  const shownDelegate = activeChat && delegateView?.key === chatKey(activeChat) ? delegateView.state : null

  return { shownDelegate, delegateBusy, delegateError, toggleDelegate }
}
