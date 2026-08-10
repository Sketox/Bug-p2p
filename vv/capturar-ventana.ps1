# Captura la ventana de una aplicación de escritorio y la guarda como evidencia.
#
# Existe por Burp Suite: es una aplicación de escritorio, así que su evidencia no se puede generar
# como las demás (Cypress captura el navegador, y los paneles de Jenkins y SonarQube son webs). Sin
# esto, las capturas de Burp habría que hacerlas a mano y recortarlas — y acaban con nombres y
# tamaños distintos cada vez.
#
# Captura SOLO la ventana pedida, no el escritorio: lo que haya alrededor no entra.
#
#   powershell -ExecutionPolicy Bypass -File vv/capturar-ventana.ps1 -Titulo "Burp Suite" -Salida "docs/vv/evidencias/laboratorio/08-burp-websockets.png"

param(
  [Parameter(Mandatory = $true)][string]$Titulo,
  [Parameter(Mandatory = $true)][string]$Salida
)

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Ventana {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# Se busca por título parcial, porque Burp añade la versión y el nombre del proyecto.
$proceso = Get-Process |
  Where-Object { $_.MainWindowTitle -like "*$Titulo*" -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proceso) {
  Write-Host "  X No encuentro ninguna ventana cuyo titulo contenga '$Titulo'."
  Write-Host "    Ventanas abiertas ahora mismo:"
  Get-Process | Where-Object { $_.MainWindowTitle } |
    ForEach-Object { Write-Host "      - $($_.MainWindowTitle)" }
  exit 1
}

# Traerla al frente: una ventana tapada se captura con lo que tenga encima.
[Ventana]::ShowWindow($proceso.MainWindowHandle, 9) | Out-Null   # 9 = SW_RESTORE
[Ventana]::SetForegroundWindow($proceso.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$r = New-Object Ventana+RECT
[Ventana]::GetWindowRect($proceso.MainWindowHandle, [ref]$r) | Out-Null
$ancho = $r.Right - $r.Left
$alto = $r.Bottom - $r.Top

if ($ancho -le 0 -or $alto -le 0) {
  Write-Host "  X La ventana no tiene tamano visible (minimizada?)."
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap $ancho, $alto
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)

$destino = [System.IO.Path]::GetFullPath($Salida)
$carpeta = [System.IO.Path]::GetDirectoryName($destino)
if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Path $carpeta -Force | Out-Null }

$bmp.Save($destino, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "  OK $destino  ($ancho x $alto)  <- $($proceso.MainWindowTitle)"
