import { useEffect, useState } from 'react'
import {
  Card, Table, Tag, Button, Modal, Form, Input, Select, message, Space, Image, Popconfirm,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
  EyeOutlined, EyeInvisibleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { getAllProducts, createProduct, updateProduct, deleteProduct } from '../services/api'
import type { Product } from '../types'

const categories = ['电子', '时尚', '美妆', '家居', '收藏品', '珠宝', '艺术', '其他']

const statusMap: Record<string, { color: string; label: string }> = {
  draft:      { color: 'default',    label: '已下架' },
  active:     { color: 'green',      label: '上架中' },
  auctioning: { color: 'processing', label: '拍卖中' },
  sold:       { color: 'gold',       label: '已售出' },
  ended:      { color: 'default',    label: '已结束' },
}

interface FormValues {
  title: string
  description?: string
  category?: string
  images?: string
}

export default function ProductsPage() {
  const [list, setList] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form] = Form.useForm<FormValues>()
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setList(await getAllProducts()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  // Convert the JSON-encoded images field to a comma-separated string for
  // the form input (and back on submit). Keeping the API contract as JSON
  // simplifies parsing on the user-facing side.
  const imagesToInput = (s?: string): string => {
    if (!s) return ''
    try { return (JSON.parse(s) as string[]).join(', ') } catch { return s }
  }
  const inputToImages = (s?: string): string => {
    if (!s?.trim()) return '[]'
    return JSON.stringify(s.split(',').map((x) => x.trim()).filter(Boolean))
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    setOpen(true)
  }
  const openEdit = (p: Product) => {
    setEditing(p)
    form.setFieldsValue({
      title: p.title,
      description: p.description,
      category: p.category,
      images: imagesToInput(p.images),
    })
    setOpen(true)
  }

  const handleSubmit = async (v: FormValues) => {
    setSubmitting(true)
    try {
      const payload = { ...v, images: inputToImages(v.images) }
      if (editing) {
        await updateProduct(editing.id, payload as Partial<Product>)
        message.success('已更新')
      } else {
        await createProduct({ ...payload, status: 'active' } as Parameters<typeof createProduct>[0])
        message.success('已创建')
      }
      setOpen(false)
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  // Toggle between draft (off-shelf) and active (on-shelf). Any other
  // status (auctioning/sold/ended) is a state-machine output and the
  // toggle is hidden via the conditional render below.
  const handleToggleStatus = async (p: Product) => {
    const next = p.status === 'active' ? 'draft' : 'active'
    try {
      await updateProduct(p.id, { status: next })
      message.success(next === 'active' ? '已上架' : '已下架')
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '操作失败')
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await deleteProduct(id)
      message.success('已删除')
      load()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } }
      message.error(e.response?.data?.error ?? '删除失败')
    }
  }

  return (
    <Card
      title="商品管理"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增商品</Button>
        </Space>
      }
    >
      <Table
        dataSource={list}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 15, showSizeChanger: true, showTotal: (t) => `共 ${t} 件` }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 70 },
          {
            title: '封面', dataIndex: 'images', width: 80, align: 'center',
            render: (v: string) => {
              try {
                const arr = JSON.parse(v) as string[]
                return arr[0] ? <Image src={arr[0]} width={50} height={50} style={{ objectFit: 'cover', borderRadius: 4 }} /> : '—'
              } catch { return '—' }
            },
          },
          { title: '标题', dataIndex: 'title', ellipsis: true },
          {
            title: '分类', dataIndex: 'category', width: 100,
            render: (v: string) => v ? <Tag>{v}</Tag> : '—',
          },
          {
            title: '状态', dataIndex: 'status', width: 100, align: 'center',
            render: (s: string) => <Tag color={statusMap[s]?.color}>{statusMap[s]?.label ?? s}</Tag>,
          },
          {
            title: '创建时间', dataIndex: 'created_at', width: 160,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
          },
          {
            title: '操作', width: 220, align: 'center',
            render: (_v, r: Product) => {
              // Locked once an auction starts referencing it — we still
              // expose a hint so users understand why the buttons disappear.
              const inAuction = r.status === 'auctioning'
              return (
                <Space size="small">
                  <Button type="link" size="small" icon={<EditOutlined />} disabled={inAuction} onClick={() => openEdit(r)}>编辑</Button>
                  {(r.status === 'active' || r.status === 'draft') && (
                    <Button
                      type="link" size="small"
                      icon={r.status === 'active' ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                      onClick={() => handleToggleStatus(r)}
                    >
                      {r.status === 'active' ? '下架' : '上架'}
                    </Button>
                  )}
                  <Popconfirm title="确认删除此商品？" onConfirm={() => handleDelete(r.id)} disabled={inAuction}>
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} disabled={inAuction}>删除</Button>
                  </Popconfirm>
                </Space>
              )
            },
          },
        ]}
      />

      <Modal
        title={editing ? '编辑商品' : '新增商品'}
        open={open}
        onCancel={() => { setOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        width={560}
        okText={editing ? '保存' : '创建'}
      >
        <Form form={form} onFinish={handleSubmit} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, max: 200 }]}>
            <Input placeholder="例：限量款 Air Jordan 1 US10" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="商品的品牌、成色、包装等..." />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select placeholder="选择分类" options={categories.map((v) => ({ label: v, value: v }))} allowClear />
          </Form.Item>
          <Form.Item name="images" label="图片链接（多张用英文逗号分隔）">
            <Input placeholder="https://example.com/a.jpg, https://..." />
          </Form.Item>
          {!editing && (
            <div style={{ color: '#999', fontSize: 12 }}>
              创建后可在「拍卖管理」页面发起拍卖。
            </div>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
