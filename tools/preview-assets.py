# 검증한 실제 대시보드 캡처에서 발표용 영역을 잘라 별도 미리보기 PNG를 만듭니다.
# 지표 값을 그리거나 바꾸지 않습니다. 이 스크립트 실행으로 앱이나 DB 상태도 바뀌지 않습니다.
"""실제 캡처에서 발표용 확대 영역과 사용자 확인용 미리보기를 만듭니다."""
from PIL import Image
from pathlib import Path
p=Path(__file__).resolve().parents[1]/'evidence'
im=Image.open(p/'02_dashboard.png');im.crop((0,0,im.width,min(1000,im.height))).save(p/'dashboard-preview.png')
im.crop((224,64,im.width,min(1000,im.height))).save(p/'dashboard-detail.png')
print('실제 화면 확대 이미지 생성')
