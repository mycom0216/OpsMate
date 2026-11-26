# 번들 LibreOffice 부재 시 설치된 Microsoft Office의 기본 PDF 내보내기를 사용합니다.
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot), [string[]]$Only = @())
$ErrorActionPreference='Stop'
$docDirectory=Join-Path $ProjectRoot 'docs'
$records=@()
if($Only.Count -gt 0 -and (Test-Path -LiteralPath (Join-Path $ProjectRoot 'evidence/office-render.json'))) { $records=@(Get-Content -LiteralPath (Join-Path $ProjectRoot 'evidence/office-render.json') -Raw | ConvertFrom-Json) }
$word=New-Object -ComObject Word.Application
$word.Visible=$false
$word.DisplayAlerts=0
try {
  foreach($file in Get-ChildItem -LiteralPath $docDirectory -Filter '*.docx' | Where-Object {$Only.Count -eq 0 -or $_.Name -in $Only}) {
    $document=$word.Documents.Open($file.FullName,$false,$true)
    try {
      $target=[IO.Path]::ChangeExtension($file.FullName,'.pdf')
      $document.ExportAsFixedFormat($target,17)
      $records=@($records | Where-Object {$_.file -ne $file.Name})
      $records+=@{file=$file.Name;pdf=[IO.Path]::GetFileName($target);pages=$document.ComputeStatistics(2);renderer='Microsoft Word'}
    } finally {$document.Close(0)}
  }
} finally {$word.Quit();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)}
$deck=Join-Path $docDirectory '최종발표자료.pptx'
if((Test-Path -LiteralPath $deck) -and ($Only.Count -eq 0 -or '최종발표자료.pptx' -in $Only)) {
  $ppt=New-Object -ComObject PowerPoint.Application
  try {
    $presentation=$ppt.Presentations.Open($deck,-1,0,0)
    try {$presentation.SaveAs([IO.Path]::ChangeExtension($deck,'.pdf'),32);$records=@($records|Where-Object {$_.file -ne '최종발표자료.pptx'});$records+=@{file='최종발표자료.pptx';pages=$presentation.Slides.Count;renderer='Microsoft PowerPoint'}} finally {$presentation.Close()}
  } finally {$ppt.Quit();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)}
}
$records|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $ProjectRoot 'evidence/office-render.json') -Encoding utf8
'Office PDF 내보내기 완료'
