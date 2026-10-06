# Renders images/icon.png (128x128) for the Marketplace listing.
# Drawn at 512px and downscaled for clean anti-aliasing. Windows only (GDI+).
Add-Type -AssemblyName System.Drawing

$size = 512
$out = Join-Path $PSScriptRoot '..\images\icon.png'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

$bg = [System.Drawing.ColorTranslator]::FromHtml('#262335')
$bubble = [System.Drawing.ColorTranslator]::FromHtml('#F2EFE9')
$coral = [System.Drawing.ColorTranslator]::FromHtml('#E0564F')

# Tile
$g.FillPath((New-Object System.Drawing.SolidBrush $bg), (New-RoundedRect 0 0 $size $size 104))

# Speech bubble with a tail at the lower left
$bubbleBrush = New-Object System.Drawing.SolidBrush $bubble
$g.FillPath($bubbleBrush, (New-RoundedRect 72 84 368 296 72))
$tail = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 136, 360),
    (New-Object System.Drawing.PointF 236, 360),
    (New-Object System.Drawing.PointF 112, 450)
)
$g.FillPolygon($bubbleBrush, $tail)

# Trash can
$coralBrush = New-Object System.Drawing.SolidBrush $coral
$handlePen = New-Object System.Drawing.Pen $coral, 16
$g.DrawPath($handlePen, (New-RoundedRect 222 122 68 44 12))
$g.FillPath($coralBrush, (New-RoundedRect 170 150 172 30 15))
$body = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 186, 194),
    (New-Object System.Drawing.PointF 326, 194),
    (New-Object System.Drawing.PointF 310, 336),
    (New-Object System.Drawing.PointF 202, 336)
)
$g.FillPolygon($coralBrush, $body)
$slatPen = New-Object System.Drawing.Pen $bubble, 13
$slatPen.StartCap = 'Round'
$slatPen.EndCap = 'Round'
foreach ($x in 224, 256, 288) { $g.DrawLine($slatPen, $x, 220, $x, 310) }
$g.Dispose()

$small = New-Object System.Drawing.Bitmap 128, 128
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.PixelOffsetMode = 'HighQuality'
$g2.SmoothingMode = 'AntiAlias'
$g2.DrawImage($bmp, 0, 0, 128, 128)
$g2.Dispose()
$small.Save((Resolve-Path (Split-Path $out)).Path + '\icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
$bmp.Dispose()
Write-Output "wrote $out"
