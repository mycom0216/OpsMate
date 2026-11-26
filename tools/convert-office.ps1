# 생성한 DOCX/PPTX를 설치된 Word/PowerPoint에서 열어 실제 PDF로 내보내는 도구입니다.
# Only 인자가 있으면 해당 파일만 처리하고 다른 문서의 변환 기록은 보존합니다.
# 읽기 전용 열기와 finally의 Close/Quit로 문서 저장이나 프로세스 잔류를 줄입니다.
# 번들 LibreOffice 부재 시 설치된 Microsoft Office의 기본 PDF 내보내기를 사용합니다.
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot), [string[]]$Only = @())
$ErrorActionPreference='Stop'
$docDirectory=Join-Path $ProjectRoot 'docs'
# 변환 증빙에는 파일명·페이지 수·렌더러를 남기며 사용자 계정이나 비밀번호는 넣지 않습니다.
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
