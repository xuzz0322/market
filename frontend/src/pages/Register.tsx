import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { register } from '../services/api'
import { useAuthStore } from '../services/store'
import wsClient from '../services/websocket'

export default function Register() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username || !email || !password) { toast.error('请填写完整信息'); return }
    if (password.length < 6) { toast.error('密码至少6位'); return }
    setLoading(true)
    try {
      const res = await register({ username, email, password })
      setAuth(res.token, res.user)
      wsClient.connect()
      toast.success('注册成功！')
      navigate('/')
    } catch {
      toast.error('注册失败，用户名或邮箱已存在')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-brand-dark flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-10">
          <div className="text-5xl mb-3">🎪</div>
          <h1 className="text-white font-black text-3xl tracking-tight">创建账号</h1>
          <p className="text-white/50 text-sm mt-1">新注册赠送 ¥10,000 余额</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名（3-20字符）"
            className="w-full bg-white/10 text-white rounded-2xl px-4 py-3.5 outline-none placeholder-white/40 focus:ring-2 focus:ring-brand-pink text-base"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            className="w-full bg-white/10 text-white rounded-2xl px-4 py-3.5 outline-none placeholder-white/40 focus:ring-2 focus:ring-brand-pink text-base"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（至少6位）"
            className="w-full bg-white/10 text-white rounded-2xl px-4 py-3.5 outline-none placeholder-white/40 focus:ring-2 focus:ring-brand-pink text-base"
          />
          <motion.button
            type="submit"
            whileTap={{ scale: 0.97 }}
            disabled={loading}
            className="w-full bg-brand-pink text-white font-black py-4 rounded-2xl text-lg disabled:opacity-60 mt-2"
          >
            {loading ? '注册中...' : '立即注册'}
          </motion.button>
        </form>

        <p className="text-center text-white/50 text-sm mt-6">
          已有账号？{' '}
          <Link to="/login" className="text-brand-pink font-bold">
            去登录
          </Link>
        </p>
      </motion.div>
    </div>
  )
}
