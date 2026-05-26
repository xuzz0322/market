import { useEffect, useState } from 'react'
import { Card, Col, Row, Statistic, Table, Tag, Spin } from 'antd'
import {
  RiseOutlined, ThunderboltOutlined, ShoppingOutlined,
  EyeOutlined, FireOutlined, UserOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { getDashboard, getTopProducts, getRecentBids } from '../services/api'
import type { DashboardStats, TopProductRow, Bid } from '../types'

const statusTag: Record<string, { color: string; label: string }> = {
  active:    { color: 'green',  label: '进行中' },
  pending:   { color: 'orange', label: '待开始' },
  ended:     { color: 'default', label: '已结束' },
  cancelled: { color: 'red',    label: '已取消' },
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [top, setTop] = useState<TopProductRow[]>([])
  const [recent, setRecent] = useState<Bid[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [s, t, r] = await Promise.all([
          getDashboard(), getTopProducts(), getRecentBids(),
        ])
        if (cancelled) return
        setStats(s)
        setTop(t)
        setRecent(r)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    // Auto-refresh every 15s so the dashboard stays fresh while the user
    // watches it. Long enough that we don't hammer the API; short enough
    // that bid count changes feel live.
    const id = setInterval(load, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (loading) return <div style={{ padding: 60, textAlign: 'center' }}><Spin size="large" /></div>

  return (
    <div>
      {/* Stat cards row */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="今日成交额"
              value={stats?.today_gmv ?? 0}
              precision={2}
              prefix="¥"
              valueStyle={{ color: '#cf1322' }}
              suffix={<RiseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="进行中拍卖"
              value={stats?.active_auctions ?? 0}
              valueStyle={{ color: '#3f8600' }}
              prefix={<ThunderboltOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="今日出价"
              value={stats?.today_bids ?? 0}
              prefix={<FireOutlined />}
              valueStyle={{ color: '#fa541c' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="实时竞拍人数"
              value={stats?.live_bidders ?? 0}
              prefix={<UserOutlined />}
              valueStyle={{ color: '#722ed1' }}
              suffix="人"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="累计观看"
              value={stats?.today_views ?? 0}
              prefix={<EyeOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <Card>
            <Statistic
              title="商品总数"
              value={stats?.total_products ?? 0}
              prefix={<ShoppingOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* Tables row */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card title="拍卖业绩 TOP 10" size="small">
            <Table
              size="small"
              dataSource={top}
              rowKey="auction_id"
              pagination={false}
              columns={[
                { title: '商品', dataIndex: 'product_title', ellipsis: true },
                {
                  title: '当前价', dataIndex: 'current_price', width: 110, align: 'right',
                  render: (v: number) => <strong style={{ color: '#cf1322' }}>¥{v.toLocaleString()}</strong>,
                },
                { title: '出价', dataIndex: 'bid_count', width: 70, align: 'center' },
                { title: '观看', dataIndex: 'view_count', width: 70, align: 'center' },
                {
                  title: '状态', dataIndex: 'status', width: 90, align: 'center',
                  render: (s: string) => <Tag color={statusTag[s]?.color}>{statusTag[s]?.label ?? s}</Tag>,
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="最近出价" size="small">
            <Table
              size="small"
              dataSource={recent}
              rowKey="id"
              pagination={{ pageSize: 8, size: 'small' }}
              columns={[
                {
                  title: '用户', dataIndex: ['user', 'username'], width: 100, ellipsis: true,
                  render: (v: string) => v ?? '—',
                },
                {
                  title: '商品', dataIndex: ['auction', 'product', 'title'], ellipsis: true,
                  render: (v: string) => v ?? '—',
                },
                {
                  title: '金额', dataIndex: 'amount', width: 100, align: 'right',
                  render: (v: number) => <span style={{ color: '#cf1322', fontWeight: 600 }}>¥{v.toLocaleString()}</span>,
                },
                {
                  title: '时间', dataIndex: 'created_at', width: 90, align: 'right',
                  render: (v: string) => <span style={{ fontSize: 11, color: '#999' }}>{dayjs(v).format('HH:mm:ss')}</span>,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
