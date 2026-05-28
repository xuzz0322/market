import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Home, PlusSquare, User, Radio, MessageSquare } from 'lucide-react'
import AuctionFeed from './components/AuctionFeed'
import AuctionDetail from './components/AuctionDetail'
import ConnectionIndicator from './components/ConnectionIndicator'
import CreateAuction from './pages/CreateAuction'
import Profile from './pages/Profile'
import MyOrders from './pages/MyOrders'
import Login from './pages/Login'
import Register from './pages/Register'
import Search from './pages/Search'
import Rooms from './pages/Rooms'
import RoomDetail from './pages/RoomDetail'
import FavoritesAndFollows from './pages/FavoritesAndFollows'
import Credit from './pages/Credit'
import TradeHistory from './pages/TradeHistory'
import Blocks from './pages/Blocks'
import Messages from './pages/Messages'
import DMThread from './pages/DMThread'
import { useAuthStore, useFavoritesStore } from './services/store'
import wsClient from './services/websocket'
import { useOutbidNotifier, ensureNotificationPermission } from './hooks/useOutbidNotifier'
import { useLiveAlertNotifier } from './hooks/useLiveAlertNotifier'
import { getDMUnread } from './services/api'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore()
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const [unread, setUnread] = useState(0)
  const { token } = useAuthStore()

  // Poll unread DM count every 30s and on incoming dm_received WS event.
  useEffect(() => {
    if (!token) return
    const fetch = () => getDMUnread().then((r) => setUnread(r.unread)).catch(() => {})
    fetch()
    const interval = setInterval(fetch, 30_000)
    const off = wsClient.on('dm_received', () => setUnread((n) => n + 1))
    return () => { clearInterval(interval); off() }
  }, [token])

  const tabs = [
    { path: '/', icon: Home, label: '广场' },
    { path: '/rooms', icon: Radio, label: '拍卖间' },
    { path: '/create', icon: PlusSquare, label: '发布' },
    { path: '/messages', icon: MessageSquare, label: '私信', badge: unread },
    { path: '/profile', icon: User, label: '我的' },
  ]

  const hideOn = ['/login', '/register']
  if (hideOn.includes(location.pathname)) return null
  if (location.pathname === '/search') return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-brand-dark/90 backdrop-blur-md border-t border-white/10 safe-area-pb">
      <div className="flex items-center justify-around py-2 max-w-lg mx-auto">
        {tabs.map(({ path, icon: Icon, label, badge }) => {
          const active = location.pathname === path || location.pathname.startsWith(path + '/')
          return (
            <button
              key={path}
              onClick={() => { navigate(path); if (path === '/messages') setUnread(0) }}
              className="flex flex-col items-center gap-0.5 px-4 py-1 relative"
            >
              <div className="relative">
                <Icon
                  size={22}
                  className={active ? 'text-brand-pink' : 'text-white/50'}
                  strokeWidth={active ? 2.5 : 1.5}
                />
                {badge != null && badge > 0 && (
                  <span className="absolute -top-1.5 -right-2 bg-brand-pink text-white text-[9px] font-bold min-w-[14px] h-3.5 px-0.5 rounded-full flex items-center justify-center">
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </div>
              <span className={`text-xs ${active ? 'text-brand-pink font-bold' : 'text-white/50'}`}>
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function App() {
  const { token } = useAuthStore()
  const hydrateFavorites = useFavoritesStore((s) => s.hydrate)

  // Global subscriptions — must mount once at the app root so they fire
  // regardless of which page the user is on when the event arrives.
  useOutbidNotifier()
  useLiveAlertNotifier()

  useEffect(() => {
    if (token) {
      wsClient.connect()
      // Ask for browser notification permission after auth — by the time
      // the user logs in they've intentionally engaged with the app.
      ensureNotificationPermission()
      hydrateFavorites()
    }
    return () => {
      wsClient.disconnect()
    }
  }, [token, hydrateFavorites])

  return (
    <div className="min-h-screen bg-brand-dark">
      <ConnectionIndicator />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<ProtectedRoute><AuctionFeed /></ProtectedRoute>} />
        <Route path="/auction/:id" element={<ProtectedRoute><AuctionDetail /></ProtectedRoute>} />
        <Route path="/create" element={<ProtectedRoute><CreateAuction /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
        <Route path="/orders" element={<ProtectedRoute><MyOrders /></ProtectedRoute>} />
        <Route path="/search" element={<ProtectedRoute><Search /></ProtectedRoute>} />
        <Route path="/rooms" element={<ProtectedRoute><Rooms /></ProtectedRoute>} />
        <Route path="/rooms/:id" element={<ProtectedRoute><RoomDetail /></ProtectedRoute>} />
        <Route path="/likes" element={<ProtectedRoute><FavoritesAndFollows /></ProtectedRoute>} />
        <Route path="/credit" element={<ProtectedRoute><Credit /></ProtectedRoute>} />
        <Route path="/trade-history" element={<ProtectedRoute><TradeHistory /></ProtectedRoute>} />
        <Route path="/blocks" element={<ProtectedRoute><Blocks /></ProtectedRoute>} />
        <Route path="/messages" element={<ProtectedRoute><Messages /></ProtectedRoute>} />
        <Route path="/messages/:id" element={<ProtectedRoute><DMThread /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav />
    </div>
  )
}
