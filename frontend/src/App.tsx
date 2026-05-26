import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Home, PlusSquare, User } from 'lucide-react'
import AuctionFeed from './components/AuctionFeed'
import AuctionDetail from './components/AuctionDetail'
import ConnectionIndicator from './components/ConnectionIndicator'
import CreateAuction from './pages/CreateAuction'
import Profile from './pages/Profile'
import MyOrders from './pages/MyOrders'
import Login from './pages/Login'
import Register from './pages/Register'
import { useAuthStore } from './services/store'
import wsClient from './services/websocket'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore()
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

function BottomNav() {
  const location = useLocation()
  const navigate = useNavigate()

  const tabs = [
    { path: '/', icon: Home, label: '广场' },
    { path: '/create', icon: PlusSquare, label: '发布' },
    { path: '/profile', icon: User, label: '我的' },
  ]

  const hideOn = ['/login', '/register']
  if (hideOn.includes(location.pathname)) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-brand-dark/90 backdrop-blur-md border-t border-white/10 safe-area-pb">
      <div className="flex items-center justify-around py-2 max-w-lg mx-auto">
        {tabs.map(({ path, icon: Icon, label }) => {
          const active = location.pathname === path
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className="flex flex-col items-center gap-0.5 px-6 py-1"
            >
              <Icon
                size={22}
                className={active ? 'text-brand-pink' : 'text-white/50'}
                strokeWidth={active ? 2.5 : 1.5}
              />
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

  useEffect(() => {
    if (token) {
      wsClient.connect()
    }
    return () => {
      wsClient.disconnect()
    }
  }, [token])

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav />
    </div>
  )
}
