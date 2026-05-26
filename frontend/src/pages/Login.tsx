import React, { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { login } from '../services/api'
import { useAuthStore } from '../services/store'
import wsClient from '../services/websocket'

export default function Login() {
  const navigate = useNavigate()
  const { setAuth } = useAuthStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email || !password) { toast.error('请填写完整信息'); return }
    setLoading(true)
    try {
      const res = await login({ email, password })
      setAuth(res.token, res.user)
      wsClient.connect()
      toast.success(`欢迎回来，${res.user.username}！`)
      navigate('/')
    } catch {
      toast.error('邮箱或密码错误')
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
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="text-5xl mb-3">🎪</div>
          <h1 className="text-white font-black text-3xl tracking-tight">拍卖直播间</h1>
          <p className="text-white/50 text-sm mt-1">实时竞拍，抢先赢得心仪好物</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="邮箱"
              className="w-full bg-white/10 text-white rounded-2xl px-4 py-3.5 outline-none placeholder-white/40 focus:ring-2 focus:ring-brand-pink text-base"
            />
          </div>
          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="密码"
              className="w-full bg-white/10 text-white rounded-2xl px-4 py-3.5 outline-none placeholder-white/40 focus:ring-2 focus:ring-brand-pink text-base"
            />
          </div>
          <motion.button
            type="submit"
            whileTap={{ scale: 0.97 }}
            disabled={loading}
            className="w-full bg-brand-pink text-white font-black py-4 rounded-2xl text-lg disabled:opacity-60 mt-2"
          >
            {loading ? '登录中...' : '登录'}
          </motion.button>
        </form>

        <p className="text-center text-white/50 text-sm mt-6">
          还没有账号？{' '}
          <Link to="/register" className="text-brand-pink font-bold">
            立即注册
          </Link>
        </p>
      </motion.div>
    </div>
  )
}
