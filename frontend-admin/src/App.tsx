import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'

import LoginPage from './pages/Login'
import Dashboard from './pages/Dashboard'
import ProductsPage from './pages/Products'
import AuctionsPage from './pages/Auctions'
import OrdersPage from './pages/Orders'
import LivePage from './pages/Live'
import MainLayout from './layouts/MainLayout'
import { useAuthStore } from './services/store'

dayjs.locale('zh-cn')

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, user } = useAuthStore()
  const location = useLocation()
  if (!token || !user) return <Navigate to="/login" state={{ from: location }} replace />
  // Belt-and-suspenders: even if a buyer somehow got an admin token,
  // the role check pushes them out. Backend RequireRole is the real gate.
  if (user.role !== 'seller' && user.role !== 'admin') {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#7e22ce',
          borderRadius: 6,
        },
      }}
    >
      <AntdApp>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth><MainLayout /></RequireAuth>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/auctions" element={<AuctionsPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/live" element={<LivePage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AntdApp>
    </ConfigProvider>
  )
}
