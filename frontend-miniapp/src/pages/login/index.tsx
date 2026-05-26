import { useState } from 'react'
import { View, Text, Input, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { login } from '../../services/api'
import './index.scss'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!email || !password) {
      Taro.showToast({ title: '请填写完整信息', icon: 'none' })
      return
    }
    setLoading(true)
    try {
      const res = await login({ email, password })
      Taro.setStorageSync('mp_token', res.token)
      Taro.setStorageSync('mp_user', res.user)
      Taro.reLaunch({ url: '/pages/index/index' })
    } catch {
      // toast already shown by api wrapper
    } finally {
      setLoading(false)
    }
  }

  return (
    <View className="login">
      <View className="login__brand">
        <Text className="login__emoji">🎪</Text>
        <Text className="login__title">拍卖直播间</Text>
        <Text className="login__subtitle">实时竞拍，抢先赢得心仪好物</Text>
      </View>

      <View className="login__form">
        <Input
          type="text"
          placeholder="邮箱"
          placeholderStyle="color:rgba(255,255,255,0.4)"
          value={email}
          onInput={(e) => setEmail(e.detail.value)}
          className="login__input"
        />
        <Input
          password
          placeholder="密码"
          placeholderStyle="color:rgba(255,255,255,0.4)"
          value={password}
          onInput={(e) => setPassword(e.detail.value)}
          className="login__input"
        />
        <Button
          loading={loading}
          onClick={handleSubmit}
          className="login__btn"
        >
          登 录
        </Button>
      </View>
    </View>
  )
}
