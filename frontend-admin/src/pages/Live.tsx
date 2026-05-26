import { useEffect, useState } from 'react'
import { Card, Row, Col, Tag, Empty, Spin, Statistic, Progress, Badge, Image } from 'antd'
import { ClockCircleOutlined, FireOutlined, EyeOutlined } from '@ant-design/icons'
import { getLiveAuctions } from '../services/api'
import type { Auction } from '../types'

interface LiveAuction extends Auction { seconds_left: number }

/** Tile color tier matches the user-side countdown: cyan / yellow / orange / red */
function tierFor(secondsLeft: number) {
  if (secondsLeft <= 10) return { color: '#ff2d55', label: '⚡ FINAL'   }
  if (secondsLeft <= 30) return { color: '#ff8a00', label: 'HURRY'      }
  if (secondsLeft <= 60) return { color: '#facc15', label: 'ENDING'     }
  return                       { color: '#22d3ee', label: 'LIVE'       }
}

function formatTime(secs: number): string {
  if (secs <= 0) return '00:00'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseFirstImage(s: string): string | null {
  try {
    const arr = JSON.parse(s) as string[]
    return arr[0] ?? null
  } catch { return null }
}

/**
 * The Live Console is the "command center" view a streamer or seller
 * watches while auctions are running. Design priorities:
 *   - At-a-glance situational awareness: who's about to end, where is
 *     activity hot, is anything stalled.
 *   - Auto-refresh every 5s — short enough that the seconds_left counters
 *     stay roughly accurate without each tile owning its own RAF loop.
 *   - Tiles re-sort by ending soonest so the most urgent ones float up.
 */
export default function LivePage() {
  const [list, setList] = useState<LiveAuction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = (await getLiveAuctions()) as LiveAuction[]
        if (!cancelled) setList(data)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 5_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Local 1s tick for visible countdowns between server fetches. We
  // accept that these can drift up to 5s before the next fetch corrects
  // them — for a monitoring dashboard that's invisible.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (loading) return <div style={{ padding: 60, textAlign: 'center' }}><Spin size="large" /></div>

  if (list.length === 0) {
    return (
      <Card>
        <Empty
          description={<span>当前没有进行中的拍卖<br /><span style={{ color: '#999', fontSize: 12 }}>从「拍卖管理」启动后会显示在这里</span></span>}
        />
      </Card>
    )
  }

  // Apply local-clock decrement so the visible timer matches reality
  // between server fetches.
  const decorated = list.map((a) => ({
    ...a,
    seconds_left: Math.max(0, a.seconds_left - 1),
  }))

  // Sort: about-to-end first.
  decorated.sort((a, b) => a.seconds_left - b.seconds_left)

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 16 }}>
        <Card size="small" style={{ flex: 1 }}>
          <Statistic
            title="正在直播的拍卖数"
            value={decorated.length}
            prefix={<Badge status="processing" />}
            valueStyle={{ color: '#52c41a' }}
          />
        </Card>
        <Card size="small" style={{ flex: 1 }}>
          <Statistic
            title="即将结束 (<60s)"
            value={decorated.filter((a) => a.seconds_left < 60).length}
            valueStyle={{ color: '#fa541c' }}
            prefix={<ClockCircleOutlined />}
          />
        </Card>
        <Card size="small" style={{ flex: 1 }}>
          <Statistic
            title="累计实时竞价金额"
            value={decorated.reduce((sum, a) => sum + a.current_price, 0)}
            precision={2}
            prefix="¥"
            valueStyle={{ color: '#cf1322' }}
          />
        </Card>
      </div>

      <Row gutter={[16, 16]}>
        {decorated.map((a) => {
          const tier = tierFor(a.seconds_left)
          const progress = (a.seconds_left / Math.max(a.duration, 1)) * 100
          const cover = parseFirstImage(a.product?.images || '')
          return (
            <Col key={a.id} xs={24} sm={12} lg={8} xxl={6}>
              <Card
                styles={{ body: { padding: 12 } }}
                style={{
                  border: `2px solid ${tier.color}`,
                  boxShadow: a.seconds_left <= 10 ? `0 0 20px ${tier.color}66` : undefined,
                  transition: 'box-shadow 0.3s',
                }}
              >
                {/* Tier badge in top-right */}
                <div style={{
                  position: 'absolute', top: 8, right: 8, zIndex: 2,
                  background: tier.color, color: '#fff',
                  padding: '2px 10px', borderRadius: 12,
                  fontSize: 10, fontWeight: 700, letterSpacing: 1,
                }}>
                  {tier.label}
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  {cover ? (
                    <Image src={cover} width={68} height={68} style={{ objectFit: 'cover', borderRadius: 6 }} preview={false} />
                  ) : (
                    <div style={{ width: 68, height: 68, background: '#f0f0f0', borderRadius: 6 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.product?.title}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Tag color="red" style={{ margin: 0 }}>¥{a.current_price.toLocaleString()}</Tag>
                      <span style={{ fontSize: 11, color: '#888' }}>
                        <FireOutlined /> {a.bid_count}
                      </span>
                      <span style={{ fontSize: 11, color: '#888' }}>
                        <EyeOutlined /> {a.view_count}
                      </span>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 10, fontFamily: 'monospace', fontSize: 22, fontWeight: 700, color: tier.color, textAlign: 'center', letterSpacing: 1 }}>
                  {formatTime(a.seconds_left)}
                </div>
                <Progress
                  percent={progress}
                  showInfo={false}
                  strokeColor={tier.color}
                  size="small"
                  style={{ marginBottom: 0 }}
                />
              </Card>
            </Col>
          )
        })}
      </Row>
    </div>
  )
}
