import { useEffect, useState } from 'react'
import { View, Text, Image, Input, Button } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getAuction, placeBid } from '../../services/api'
import type { Auction } from '../../types'
import './index.scss'

function parseFirstImage(s?: string): string {
  if (!s) return ''
  try { return (JSON.parse(s) as string[])[0] ?? '' } catch { return '' }
}

function formatTime(secs: number): string {
  if (secs <= 0) return '00:00'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// uuid v4 polyfill — Taro/weapp doesn't ship crypto.randomUUID
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Mini-program detail page.
 *
 * Strategy difference vs. the H5 version:
 *   - H5 has a persistent WebSocket connection that pushes bid_update
 *     deltas. WeChat mini-programs DO support wx.connectSocket, but the
 *     authentication and reconnect story is more complex (WS doesn't
 *     attach the auth header by default; on iOS background the conn
 *     dies). For the starter we use a poll-every-2s approach which is
 *     plenty for the bidder UX and survives backgrounding.
 *   - When this app graduates beyond MVP, swap pollLoop() below for a
 *     wsClient that mirrors the H5 implementation in services/websocket.
 */
export default function DetailPage() {
  const router = useRouter()
  const auctionId = Number(router.params.id)

  const [auction, setAuction] = useState<Auction | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [bidInput, setBidInput] = useState('')
  const [bidding, setBidding] = useState(false)

  const refresh = async () => {
    try {
      const res = await getAuction(auctionId)
      setAuction(res.auction)
      setSecondsLeft(res.seconds_left)
    } catch { /* api wrapper toasts */ }
  }

  useEffect(() => {
    refresh()
    // Poll every 2s while the page is visible.
    const id = setInterval(refresh, 2000)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId])

  // Local 1s tick keeps the displayed timer smooth between polls.
  useEffect(() => {
    if (secondsLeft <= 0) return
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(id)
  }, [secondsLeft])

  const handleBid = async () => {
    if (!auction) return
    const amount = parseFloat(bidInput)
    if (isNaN(amount) || amount <= 0) {
      Taro.showToast({ title: '请输入有效金额', icon: 'none' })
      return
    }
    const minBid = auction.bid_count === 0 ? auction.start_price : auction.current_price + auction.min_increment
    if (amount < minBid) {
      Taro.showToast({ title: `最低 ¥${minBid}`, icon: 'none' })
      return
    }
    setBidding(true)
    try {
      // client_bid_id makes this idempotent — if the WeChat network
      // retries the call, the backend returns the same bid.
      await placeBid(auctionId, amount, uuid())
      Taro.showToast({ title: '出价成功', icon: 'success' })
      setBidInput('')
      refresh()
    } catch { /* api wrapper toasts */ } finally {
      setBidding(false)
    }
  }

  if (!auction) {
    return <View className="loading">加载中...</View>
  }

  const cover = parseFirstImage(auction.product?.images) || `https://picsum.photos/seed/${auction.id}/600/600`
  const minNextBid = auction.bid_count === 0 ? auction.start_price : auction.current_price + auction.min_increment
  const urgent = secondsLeft > 0 && secondsLeft <= 30

  return (
    <View className="detail">
      <Image src={cover} mode="aspectFill" className="detail__cover" />
      <View className="detail__overlay" />

      <View className="detail__content">
        <Text className="detail__title">{auction.product?.title}</Text>
        <Text className="detail__desc">{auction.product?.description}</Text>

        <View className="detail__price-row">
          <View>
            <Text className="detail__label">当前价</Text>
            <Text className="detail__price">¥{auction.current_price.toLocaleString()}</Text>
          </View>
          <View className={`detail__timer ${urgent ? 'detail__timer--urgent' : ''}`}>
            <Text className="detail__label">剩余</Text>
            <Text className="detail__time">{formatTime(secondsLeft)}</Text>
          </View>
        </View>

        <View className="detail__stats">
          <Text className="detail__stat">出价 {auction.bid_count} 次</Text>
          <Text className="detail__stat">·</Text>
          <Text className="detail__stat">{auction.view_count} 人观看</Text>
        </View>

        {auction.status === 'active' && (
          <View className="detail__bid">
            <Input
              type="digit"
              value={bidInput}
              onInput={(e) => setBidInput(e.detail.value)}
              placeholder={`最低 ¥${minNextBid}`}
              placeholderStyle="color:rgba(255,255,255,0.4)"
              className="detail__input"
            />
            <Button loading={bidding} onClick={handleBid} className="detail__btn">
              出价
            </Button>
          </View>
        )}

        {auction.status === 'ended' && (
          <View className="detail__ended">🏁 拍卖已结束 — 最终成交价 ¥{auction.current_price.toLocaleString()}</View>
        )}
        {auction.status === 'cancelled' && (
          <View className="detail__cancelled">⚠️ 卖家已取消该拍卖</View>
        )}
      </View>
    </View>
  )
}
