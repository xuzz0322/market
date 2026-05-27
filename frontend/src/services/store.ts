import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../types'
import { myFavoriteIDs, favoriteAuction, unfavoriteAuction } from './api'

interface AuthState {
  token: string | null
  user: User | null
  setAuth: (token: string, user: User) => void
  clearAuth: () => void
  updateUser: (user: Partial<User>) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => {
        localStorage.setItem('token', token)
        set({ token, user })
      },
      clearAuth: () => {
        localStorage.removeItem('token')
        set({ token: null, user: null })
      },
      updateUser: (partial) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...partial } : null,
        })),
    }),
    { name: 'auth-storage' }
  )
)

interface FavoritesState {
  ids: Set<number>
  loaded: boolean
  /** Hydrate from server. Idempotent — safe to call on every login. */
  hydrate: () => Promise<void>
  /** Toggle favorite state. Optimistic — UI flips immediately, reverts on error. */
  toggle: (auctionId: number) => Promise<boolean>
  isFavorited: (auctionId: number) => boolean
  /** Drop the cache (called on logout). */
  reset: () => void
}

// Favorites store. Keyed by Set so existence checks are O(1) when rendering
// many auction cards. We deliberately don't persist this to localStorage —
// the server is the source of truth, and a stale local cache surviving
// across sessions just creates "I unfavorited this on phone but it's still
// hearted on web" weirdness.
export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  ids: new Set(),
  loaded: false,
  hydrate: async () => {
    try {
      const ids = await myFavoriteIDs()
      set({ ids: new Set(ids), loaded: true })
    } catch {
      // Silent — favorites are non-critical. The next interaction will
      // try again, and individual API calls validate server-side anyway.
      set({ loaded: true })
    }
  },
  toggle: async (auctionId) => {
    const next = !get().ids.has(auctionId)
    // Optimistic flip.
    set((s) => {
      const ids = new Set(s.ids)
      if (next) ids.add(auctionId); else ids.delete(auctionId)
      return { ids }
    })
    try {
      if (next) await favoriteAuction(auctionId)
      else await unfavoriteAuction(auctionId)
      return next
    } catch (e) {
      // Revert on failure.
      set((s) => {
        const ids = new Set(s.ids)
        if (next) ids.delete(auctionId); else ids.add(auctionId)
        return { ids }
      })
      throw e
    }
  },
  isFavorited: (auctionId) => get().ids.has(auctionId),
  reset: () => set({ ids: new Set(), loaded: false }),
}))
