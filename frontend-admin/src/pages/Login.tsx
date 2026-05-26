import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, Tabs, message } from 'antd'
import { ShopOutlined, MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons'
import { login, register } from '../services/api'
import { useAuthStore } from '../services/store'

export default function LoginPage() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [loading, setLoading] = useState(false)

  const handleLogin = async (values: { email: string; password: string }) => {
    setLoading(true)
    try {
      const res = await login(values)
      // Gate at the UI level too — buyer accounts shouldn't see the admin
      // shell even if they hit /login here. The backend RequireRole
      // middleware also enforces this on every API call.
      if (res.user.role !== 'seller' && res.user.role !== 'admin') {
        message.error('该账号无管理后台权限，请使用商家或管理员账号登录')
        return
      }
      setAuth(res.token, res.user)
      message.success(`欢迎回来，${res.user.username}`)
      navigate('/')
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '登录失败')
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (values: { username: string; email: string; password: string }) => {
    setLoading(true)
    try {
      const res = await register({ ...values, role: 'seller' })
      setAuth(res.token, res.user)
      message.success('注册成功')
      navigate('/')
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #7e22ce 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <Card style={{ width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <ShopOutlined style={{ fontSize: 48, color: '#7e22ce' }} />
          <h1 style={{ margin: '12px 0 4px', fontSize: 24, fontWeight: 700 }}>商家管理后台</h1>
          <p style={{ color: '#666', fontSize: 13, margin: 0 }}>拍卖直播间 · 后台控制中心</p>
        </div>

        <Tabs
          centered
          items={[
            {
              key: 'login',
              label: '登录',
              children: (
                <Form layout="vertical" onFinish={handleLogin} size="large">
                  <Form.Item name="email" rules={[{ required: true, type: 'email', message: '请输入邮箱' }]}>
                    <Input prefix={<MailOutlined />} placeholder="邮箱" />
                  </Form.Item>
                  <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
                    <Input.Password prefix={<LockOutlined />} placeholder="密码" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>登 录</Button>
                </Form>
              ),
            },
            {
              key: 'register',
              label: '商家入驻',
              children: (
                <Form layout="vertical" onFinish={handleRegister} size="large">
                  <Form.Item name="username" rules={[{ required: true, min: 3, message: '至少 3 字符' }]}>
                    <Input prefix={<UserOutlined />} placeholder="商家名称" />
                  </Form.Item>
                  <Form.Item name="email" rules={[{ required: true, type: 'email', message: '请输入邮箱' }]}>
                    <Input prefix={<MailOutlined />} placeholder="邮箱" />
                  </Form.Item>
                  <Form.Item name="password" rules={[{ required: true, min: 6, message: '至少 6 位' }]}>
                    <Input.Password prefix={<LockOutlined />} placeholder="密码（≥6位）" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" block loading={loading}>立即入驻</Button>
                </Form>
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
