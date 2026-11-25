<#
.SYNOPSIS
  Firma digitalmente (Authenticode) el ejecutable y los instaladores (.msi y -setup.exe) de Punto de Ventas.

.DESCRIPTION
  Modos de uso:
  1) Certificado comercial / de entidad certificadora (DigiCert, Sectigo, SSL.com, etc.):
     - Definir $env:WINDOWS_CERTIFICATE_THUMBPRINT = "< huella SHA1 del certificado en Cert:\CurrentUser\My >"
       y ejecutar: .\scripts\firmar_instaladores_windows.ps1
  2) Certificado de desarrollador autofirmado local (para pruebas o terminales propias donde se instale el .cer en Raíz de Confianza):
     - Ejecutar: .\scripts\firmar_instaladores_windows.ps1 -AutogeneradoLocal
     - Si se agrega -InstalarEnRaizLocal, instala el certificado público en las Entidades de Certificación Raíz de Confianza
       del usuario actual para que Windows reconozca la firma de "GAR - Guillermo Adolfo Rohde" en esta PC.
#>

param(
  [switch]$AutogeneradoLocal,
  [switch]$InstalarEnRaizLocal
)

$ErrorActionPreference = "Stop"
$SubjectEditor = "CN=GAR - Guillermo Adolfo Rohde, O=GAR - Guillermo Adolfo Rohde, C=AR"
$CertActual = $null

if ($env:WINDOWS_CERTIFICATE_THUMBPRINT) {
  $Thumb = $env:WINDOWS_CERTIFICATE_THUMBPRINT.Trim()
  $CertActual = Get-ChildItem "Cert:\CurrentUser\My\$Thumb" -ErrorAction SilentlyContinue
  if (-not $CertActual) {
    $CertActual = Get-ChildItem "Cert:\LocalMachine\My\$Thumb" -ErrorAction SilentlyContinue
  }
  if (-not $CertActual) {
    throw "No se encontró el certificado con huella '$Thumb' en CurrentUser\My ni LocalMachine\My."
  }
} elseif ($AutogeneradoLocal) {
  $CertActual = Get-ChildItem "Cert:\CurrentUser\My" |
    Where-Object { $_.Subject -eq $SubjectEditor -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1

  if (-not $CertActual) {
    Write-Host "Generando certificado de firma de código para '$SubjectEditor'..." -ForegroundColor Cyan
    $CertActual = New-SelfSignedCertificate `
      -Type CodeSigningCert `
      -Subject $SubjectEditor `
      -FriendlyName "GAR - Guillermo Adolfo Rohde (Code Signing)" `
      -CertStoreLocation "Cert:\CurrentUser\My" `
      -KeyExportPolicy Exportable `
      -KeyLength 2048 `
      -HashAlgorithm "SHA256" `
      -NotAfter (Get-Date).AddYears(5)
  }

  $RutaCerPublico = Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\GAR_Guillermo_Adolfo_Rohde_CodeSigning.cer"
  $DirBundle = Split-Path $RutaCerPublico -Parent
  if (Test-Path $DirBundle) {
    Export-Certificate -Cert $CertActual -FilePath $RutaCerPublico -Force | Out-Null
    Write-Host "Certificado público exportado en: $RutaCerPublico" -ForegroundColor Green
  }
} else {
  Write-Host "Indicá -AutogeneradoLocal o configurá `$env:WINDOWS_CERTIFICATE_THUMBPRINT." -ForegroundColor Yellow
  exit 1
}

$ArchivosAFirmar = @(
  "src-tauri\target\release\punto-de-ventas.exe",
  "src-tauri\target\release\bundle\msi\Punto de Ventas_0.1.0_x64_en-US.msi",
  "src-tauri\target\release\bundle\msi\Punto de Ventas_0.1.0_x64_es-ES.msi",
  "src-tauri\target\release\bundle\nsis\Punto de Ventas_0.1.0_x64-setup.exe"
)

foreach ($RelPath in $ArchivosAFirmar) {
  $FullPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")) $RelPath
  if (Test-Path $FullPath) {
    Write-Host "Firmando: $FullPath" -ForegroundColor Cyan
    $Res = Set-AuthenticodeSignature -FilePath $FullPath -Certificate $CertActual -HashAlgorithm SHA256
    Write-Host "  Estado firma: $($Res.Status) ($($Res.SignerCertificate.Subject))" -ForegroundColor Green
  }
}

if ($AutogeneradoLocal -and $InstalarEnRaizLocal) {
  Write-Host "Instalando certificado en CurrentUser\Root (confirmá el diálogo de Windows si aparece)..." -ForegroundColor Cyan
  $StoreRoot = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
  $StoreRoot.Open("ReadWrite")
  $StoreRoot.Add($CertActual)
  $StoreRoot.Close()
  Write-Host "Certificado instalado en Entidades de Certificación Raíz de Confianza (CurrentUser\Root)." -ForegroundColor Green
}
