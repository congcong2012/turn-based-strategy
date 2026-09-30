import { useEffect, useState } from 'react'

/**
 * 捐赠入口：点击后显示收款码。
 * 图片放在 public/donate-qrcode.png，构建后原样发布（用 BASE_URL 引用，子路径部署也正确）。
 */
export function DonateDialog() {
  const [open, setOpen] = useState(false)
  const qrSrc = import.meta.env.BASE_URL + 'donate-qrcode.png'

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button type="button" className="donate-button" data-testid="donate-button" onClick={() => setOpen(true)}>
        ❤ 请我喝杯茶
      </button>

      {open ? (
        <div className="overlay" data-testid="donate-dialog" onClick={() => setOpen(false)}>
          <div className="overlay-card donate-card" onClick={(event) => event.stopPropagation()}>
            <h2>扫码请我喝杯茶</h2>
            <p className="muted small">纯粹是鼓励：游戏永久免费、无广告、无账号，也不收集任何数据。</p>
            <img className="donate-qr" src={qrSrc} alt="收款二维码" data-testid="donate-qrcode" />
            <p className="muted small">手机上可长按图片保存后再扫码；电脑上请直接用手机扫屏幕。</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <a className="link-button" href={qrSrc} target="_blank" rel="noreferrer">
                在新标签页打开图片
              </a>
              <button type="button" data-testid="donate-close" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
