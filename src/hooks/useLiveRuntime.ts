import { useCallback, useEffect, useRef, useState } from 'react'
import { reduceLiveRuntime, type LiveRuntime } from '../lib/runtime-state'

export function useLiveRuntime(openProfile: string | undefined, openSessionId: string | undefined) {
  const byProfileRef = useRef(new Map<string, LiveRuntime | null>())
  const [liveRuntime, setLiveRuntime] = useState<LiveRuntime | null>(null)

  useEffect(() => {
    setLiveRuntime(openProfile ? (byProfileRef.current.get(openProfile) ?? null) : null)
  }, [openProfile, openSessionId])

  const applyRuntimeEvent = useCallback((profile: string, event: { type: string; payload: Record<string, unknown> }, selectedModel?: string, isOpenProfile?: boolean) => {
    const prev = byProfileRef.current.get(profile) ?? null
    const next = reduceLiveRuntime(prev, event, selectedModel)
    if (next === prev) return prev
    byProfileRef.current.set(profile, next)
    if (isOpenProfile) setLiveRuntime(next)
    return next
  }, [])

  const clearRuntime = useCallback((profile: string, isOpenProfile?: boolean) => {
    byProfileRef.current.delete(profile)
    if (isOpenProfile) setLiveRuntime(null)
  }, [])

  const getRuntime = useCallback((profile: string) => byProfileRef.current.get(profile) ?? null, [])

  return { liveRuntime, applyRuntimeEvent, clearRuntime, getRuntime }
}
