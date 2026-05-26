import { Layout, Menu, Avatar, Dropdown, theme } from 'antd'
import {
  DashboardOutlined,
  ShoppingOutlined,
  AuditOutlined,
  PlayCircleOutlined,
  ProfileOutlined,
  LogoutOutlined,
  ShopOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../services/store'

const { Header, Sider, Content } = Layout

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, clearAuth } = useAuthStore()
  const { token } = theme.useToken()

  const menuItems = [
    { key: '/',          icon: <DashboardOutlined />,  label: '数据看板' },
    { key: '/products',  icon: <ShoppingOutlined />,    label: '商品管理' },
    { key: '/auctions',  icon: <AuditOutlined />,       label: '拍卖管理' },
    { key: '/orders',    icon: <ProfileOutlined />,     label: '订单管理' },
    { key: '/live',      icon: <PlayCircleOutlined />,  label: '直播控制台' },
  ]

  // Active menu key derived from path. Splitting on the second slash so
  // /products/123 still highlights "商品管理".
  const selectedKey = '/' + (location.pathname.split('/')[1] || '')

  const handleLogout = () => {
    clearAuth()
    navigate('/login')
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        width={220}
        theme="dark"
        breakpoint="lg"
        collapsedWidth="0"
        style={{ position: 'fixed', height: '100vh', left: 0, top: 0, bottom: 0 }}
      >
        <div style={{
          height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 18, fontWeight: 700, gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <ShopOutlined /> 商家后台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>

      <Layout style={{ marginLeft: 220 }}>
        <Header style={{
          background: token.colorBgContainer,
          padding: '0 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {menuItems.find((m) => m.key === selectedKey)?.label ?? ''}
          </div>
          <Dropdown
            menu={{
              items: [
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: handleLogout },
              ],
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <Avatar style={{ background: '#7e22ce' }}>{user?.username[0]?.toUpperCase()}</Avatar>
              <div>
                <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{user?.username}</div>
                <div style={{ fontSize: 11, color: '#999' }}>
                  {user?.role === 'admin' ? '平台管理员' : '商家'}
                </div>
              </div>
            </div>
          </Dropdown>
        </Header>

        <Content style={{ padding: 24, background: '#f5f5f5' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
