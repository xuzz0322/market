import { useEffect, useState } from 'react'
import { View, Text, Image, ScrollView } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { listAuctions } from '../../services/api'
import type { Auction } from '../../types'
import './index.scss'

function parseFirstImage(s?: string): string {
  if (!s) return ''
  try {
    const arr = JSON.parse(s) as string[]
    return arr[0] ?? ''
  } catch {
    return ''
  }
}

function formatRemaining(secs: number): string {
  if (secs <= 0) return '00:00'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function IndexPage() {
  const [list, setList] = useState<Auction[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await listAuctions()
      setList(data)
    } catch {
      /* api wrapper toasts on its own */
    } finally {
      setLoading(false)
    }
  }

  // Refresh on every show — coming back from a detail page should reflect
  // the latest current_price even though we don't have a live WS here yet.
  useDidShow(() => {
    // Auth gate: bounce to login if no token. Same UX as the H5 auth flow.
    const token = Taro.getStorageSync('mp_token')
    if (!token) {
      Taro.redirectTo({ url: '/pages/login/index' })
      return
    }
    load()
  })

  // Pull-to-refresh — uses the platform's native gesture (weapp shows the
  // wechat refresh indicator; H5 falls back to a basic top-bounce).
  usePullDownRefresh(async () => {
    await load()
    Taro.stopPullDownRefresh()
  })

  // Local 1-second tick so card timers visibly count down between fetches.
  // We DON'T re-fetch every second — the fetch happens on show + manual
  // refresh. This is the right tradeoff for a list view.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (loading && list.length === 0) {
    return <View className="empty">加载中...</View>
  }
  if (!loading && list.length === 0) {
    return (
      <View className="empty">
        <Text className="empty__emoji">🎪</Text>
        <Text className="empty__text">暂无进行中的拍卖</Text>
      </View>
    )
  }

  return (
    <ScrollView scrollY className="feed">
      {list.map((a) => {
        const cover = parseFirstImage(a.product?.images) || `https://picsum.photos/seed/${a.id * 7}/400/600`
        // We compute seconds_left locally if the server provided end_time.
        // The server-side seconds_left is only fresh at fetch time.
        let secsLeft = a.seconds_left ?? 0
        if (a.end_time) {
          secsLeft = Math.max(0, Math.floor((new Date(a.end_time).getTime() - Date.now()) / 1000))
        }
        const urgent = secsLeft > 0 && secsLeft <= 30

        return (
          <View
            key={a.id}
            className="card"
            onClick={() => Taro.navigateTo({ url: `/pages/detail/index?id=${a.id}` })}
          >
            <Image src={cover} mode="aspectFill" className="card__cover" />
            <View className="card__overlay" />

            <View className="card__top">
              <Text className="card__live">🔴 直播竞拍</Text>
              {urgent && <Text className="card__urgent">⚡ 即将结束</Text>}
            </View>

            <View className="card__bottom">
              <Text className="card__title">{a.product?.title}</Text>
              <View className="card__row">
                <View className="card__price">
                  <Text className="card__price-label">当前价</Text>
                  <Text className="card__price-value">¥{a.current_price.toLocaleString()}</Text>
                </View>
                <View className="card__bidcount">
                  <Text className="card__price-label">出价</Text>
                  <Text className="card__price-value">{a.bid_count}</Text>
                </View>
                <View className={`card__timer ${urgent ? 'card__timer--urgent' : ''}`}>
                  <Text className="card__price-label">剩余</Text>
                  <Text className="card__price-value">{formatRemaining(secsLeft)}</Text>
                </View>
              </View>
            </View>
          </View>
        )
      })}
    </ScrollView>
  )
}
