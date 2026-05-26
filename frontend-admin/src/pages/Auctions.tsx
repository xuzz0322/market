import { useEffect, useState } from 'react'
import {
  Card, Table, Tag, Button, Modal, Form, InputNumber, Switch, Select,
  message, Space, Tabs, Popconfirm, Input,
} from 'antd'
import { PlusOutlined, ReloadOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  getAllAuctions, getAllProducts, createAuction, startAuction, cancelAuction,
} from '../services/api'
import type { Auction, Product } from '../types'

const statusMap: Record<string, { color: string; label: string }> = {
  pending:   { color: 'orange',     label: '待开始' },
  active:    { color: 'green',      label: '进行中' },
  ended:     { color: 'default',    label: '已结束' },
  cancelled: { color: 'red',        label: '已取消' },
}

const durationOptions = [
  { label: '5 分钟',  value: 300 },
  { label: '10 分钟', value: 600 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时',  value: 3600 },
  { label: '3 小时',  value: 10800 },
  { label: '24 小时', value: 86400 },
]

export default function AuctionsPage() {
  const [list, setList] = useState<Auction[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [hasBuyNow, setHasBuyNow] = useState(false)
  const [hasReserve, setHasReserve] = useState(false)

  // Cancel dialog state
  const [cancelTarget, setCancelTarget] = useState<Auction | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const [auctions, prods] = await Promise.all([
        getAllAuctions(statusFilter || undefined),
        getAllProducts(),
      ])
      setList(auctions)
      setProducts(prods)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [statusFilter])

  // Only show products in "active" state — the others are sold/in-auction.
  const eligibleProducts = products.filter((p) => p.status === 'active')

  const handleCreate = async (v: {
    product_id: number; start_price: number; min_increment: number;
    has_reserve: boolean; reserve_price?: number;
    has_buy_now: boolean; buy_now_price?: number; duration: number;
    auto_start: boolean;
  }) => {
    setSubmitting(true)
    try {
      const auction = await createAuction({
        product_id:    v.product_id,
        start_price:   v.start_price,
        min_increment: v.min_increment,
        has_reserve:   v.has_reserve,
        reserve_price: v.has_reserve ? v.reserve_price : undefined,
        has_buy_now:   v.has_buy_now,
        buy_now_price: v.has_buy_now ? v.buy_now_price : undefined,
        duration:      v.duration,
      })
      if (v.auto_start) {
        await startAuction(auction.id)
        message.success('拍卖已创建并开始')
      } else {
        message.success('拍卖已创建（待开始）')
      }
      setOpen(false)
      form.resetFields()
      setHasBuyNow(false)
      setHasReserve(false)
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleStart = async (id: number) => {
    try {
      await startAuction(id)
      message.success('拍卖已开始')
      load()
    } catch { message.error('开始失败') }
  }

  const handleCancel = async () => {
    if (!cancelTarget || !cancelReason.trim()) return
    try {
      await cancelAuction(cancelTarget.id, cancelReason.trim())
      message.success('拍卖已取消')
      setCancelTarget(null)
      setCancelReason('')
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '取消失败')
    }
  }

  return (
    <Card
      title={
        <Tabs
          items={[
            { key: '',          label: '全部' },
            { key: 'active',    label: '进行中' },
            { key: 'pending',   label: '待开始' },
            { key: 'ended',     label: '已结束' },
            { key: 'cancelled', label: '已取消' },
          ]}
          activeKey={statusFilter}
          onChange={setStatusFilter}
          style={{ marginBottom: -16 }}
        />
      }
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>发起拍卖</Button>
        </Space>
      }
    >
      <Table
        dataSource={list}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 70 },
          { title: '商品', dataIndex: ['product', 'title'], ellipsis: true },
          {
            title: '当前价', dataIndex: 'current_price', width: 110, align: 'right',
            render: (v: number) => <strong style={{ color: '#cf1322' }}>¥{v.toLocaleString()}</strong>,
          },
          {
            title: '加价', dataIndex: 'min_increment', width: 80, align: 'right',
            render: (v: number) => `+¥${v}`,
          },
          {
            title: '保留价', dataIndex: 'reserve_price', width: 100, align: 'right',
            render: (v: number, r: Auction) => r.has_reserve ? <span style={{ color: '#1677ff' }}>¥{v.toLocaleString()}</span> : '—',
          },
          {
            title: '封顶价', dataIndex: 'buy_now_price', width: 100, align: 'right',
            render: (v: number, r: Auction) => r.has_buy_now ? <span style={{ color: '#fa8c16' }}>¥{v.toLocaleString()}</span> : '—',
          },
          { title: '出价', dataIndex: 'bid_count', width: 70, align: 'center' },
          { title: '观看', dataIndex: 'view_count', width: 70, align: 'center' },
          {
            title: '状态', dataIndex: 'status', width: 100, align: 'center',
            render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label ?? s}</Tag>,
          },
          {
            title: '结束时间', dataIndex: 'end_time', width: 160,
            render: (v: string) => v ? dayjs(v).format('MM-DD HH:mm:ss') : '—',
          },
          {
            title: '操作', width: 160, align: 'center',
            render: (_v, r: Auction) => (
              <Space size="small">
                {r.status === 'pending' && (
                  <Popconfirm title="开始拍卖？" onConfirm={() => handleStart(r.id)}>
                    <Button type="link" size="small" icon={<PlayCircleOutlined />}>开始</Button>
                  </Popconfirm>
                )}
                {(r.status === 'pending' || r.status === 'active') && (
                  <Button
                    type="link" size="small" danger icon={<StopOutlined />}
                    onClick={() => { setCancelTarget(r); setCancelReason('') }}
                  >
                    取消
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      {/* Create modal */}
      <Modal
        title="发起拍卖"
        open={open}
        onCancel={() => { setOpen(false); form.resetFields(); setHasBuyNow(false) }}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={560}
        okText="确认"
      >
        <Form
          form={form}
          onFinish={handleCreate}
          layout="vertical"
          style={{ marginTop: 16 }}
          initialValues={{
            min_increment: 10, duration: 300, auto_start: true,
            has_buy_now: false, has_reserve: false,
          }}
        >
          <Form.Item name="product_id" label="商品" rules={[{ required: true, message: '请选择商品' }]}>
            <Select
              placeholder={eligibleProducts.length ? '选择要拍卖的商品' : '没有可用商品（需先创建）'}
              options={eligibleProducts.map((p) => ({ label: `#${p.id} ${p.title}`, value: p.id }))}
              showSearch
              optionFilterProp="label"
              disabled={!eligibleProducts.length}
            />
          </Form.Item>
          <Form.Item name="start_price" label="起拍价 (¥) — 可设 0 元" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="min_increment" label="加价幅度 (¥)" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="has_reserve" label="启用保留价（未达不成交）" valuePropName="checked">
            <Switch onChange={setHasReserve} />
          </Form.Item>
          {hasReserve && (
            <Form.Item
              name="reserve_price"
              label="保留价 (¥) — 必须 ≥ 起拍价"
              rules={[{ required: true, message: '请输入保留价' }]}
              extra="拍卖结束时若最高价低于此数，本场流拍（无人成交）"
            >
              <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="has_buy_now" label="启用封顶价（一口价）" valuePropName="checked">
            <Switch onChange={setHasBuyNow} />
          </Form.Item>
          {hasBuyNow && (
            <Form.Item name="buy_now_price" label="封顶价 (¥) — 必须大于起拍价" rules={[{ required: true }]}>
              <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="duration" label="竞拍时长" rules={[{ required: true }]}>
            <Select options={durationOptions} />
          </Form.Item>
          <Form.Item name="auto_start" label="立即开始" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* Cancel modal — separate from the create modal so we can show the
          target's bid count and require an explicit reason. */}
      <Modal
        title="取消拍卖"
        open={!!cancelTarget}
        onCancel={() => setCancelTarget(null)}
        onOk={handleCancel}
        okButtonProps={{ danger: true, disabled: !cancelReason.trim() }}
        okText="确认取消"
      >
        {cancelTarget && (
          <div>
            <p>《{cancelTarget.product?.title}》将立即停止竞拍。</p>
            {cancelTarget.bid_count > 0 && (
              <p style={{ color: '#fa8c16' }}>
                ⚠️ 已有 {cancelTarget.bid_count} 次出价，所有竞拍者将收到通知。
              </p>
            )}
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              placeholder="请填写取消原因（必填，将向竞拍者公示）"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
        )}
      </Modal>
    </Card>
  )
}
