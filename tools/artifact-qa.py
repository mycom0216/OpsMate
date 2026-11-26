"""OOXML ZIP/XML/관계, PDF 무결성 및 도형 경계를 검사하고 전 페이지 PNG를 만듭니다."""
from pathlib import Path
import json,zipfile,posixpath,xml.etree.ElementTree as ET,sqlite3
from PIL import Image,ImageDraw,ImageFont
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader
import pypdfium2 as pdfium
from pptx import Presentation
ROOT=Path(__file__).resolve().parents[1];DOCS=ROOT/'docs';E=ROOT/'evidence';RENDER=E/'rendered';RENDER.mkdir(exist_ok=True)

for name in ['ERD','시스템아키텍처']:
    canvas=Canvas(str(DOCS/f'{name}.pdf'),pagesize=(900,550));canvas.drawImage(str(DOCS/f'{name}.png'),0,0,width=900,height=550);canvas.showPage();canvas.save()
report={'ooxml':[],'pdf':[],'slides':{},'demo_db':{},'issues':[]}
for file in list(DOCS.glob('*.docx'))+list(DOCS.glob('*.pptx'))+list(DOCS.glob('*.xlsx')):
    with zipfile.ZipFile(file)as z:
        bad=z.testzip();names=set(z.namelist());missing=[]
        for n in names:
            if n.endswith('.xml')or n.endswith('.rels'):ET.fromstring(z.read(n))
            if n.endswith('.rels'):
                parent=posixpath.dirname(posixpath.dirname(n))
                for rel in ET.fromstring(z.read(n)):
                    if rel.attrib.get('TargetMode')=='External':continue
                    target=rel.attrib.get('Target','').replace('\\','/')
                    full=target.lstrip('/')if target.startswith('/')else posixpath.normpath(posixpath.join(parent,target))
                    if full not in names:missing.append(full)
        report['ooxml'].append({'file':file.name,'crc_ok':bad is None,'xml_ok':True,'missing_relationships':missing})
        if bad or missing:report['issues'].append({'file':file.name,'bad':bad,'missing':missing})

deck=Presentation(DOCS/'최종발표자료.pptx');bounds=[]
for i,slide in enumerate(deck.slides):
    for shape in slide.shapes:
        if shape.left<0 or shape.top<0 or shape.left+shape.width>deck.slide_width+10000 or shape.top+shape.height>deck.slide_height+10000:bounds.append({'slide':i+1,'shape':shape.name})
report['slides']={'count':len(deck.slides),'outside_canvas':bounds,'speaker_notes':sum(bool(s.notes_slide.notes_text_frame.text.strip())for s in deck.slides)}
if bounds:report['issues'].append({'slide_bounds':bounds})
font=ImageFont.truetype('C:/Windows/Fonts/malgun.ttf',18)
for file in sorted(DOCS.glob('*.pdf')):
    reader=PdfReader(file);pages=[];target=RENDER/file.stem;target.mkdir(exist_ok=True)
    # 이전 렌더보다 페이지가 줄었을 때 남는 과거 페이지 PNG만 정리합니다.
    for old in target.glob('page-*.png'):old.unlink()
    pdf=pdfium.PdfDocument(str(file))
    for i in range(len(pdf)):
        page=pdf[i];image=page.render(scale=1.6).to_pil();image.save(target/f'page-{i+1:02}.png');pages.append(image.copy())
    thumbs=[]
    for i,image in enumerate(pages):
        image.thumbnail((470,620));thumb=Image.new('RGB',(500,660),'#e7edf3');thumb.paste(image,((500-image.width)//2,27));ImageDraw.Draw(thumb).text((12,635),f'{file.stem} {i+1}',font=font,fill='#162b42');thumbs.append(thumb)
    for offset in range(0,len(thumbs),6):
        batch=thumbs[offset:offset+6];cols=min(3,len(batch));rows=(len(batch)+cols-1)//cols;sheet=Image.new('RGB',(cols*500,rows*660),'white')
        for j,thumb in enumerate(batch):sheet.paste(thumb,((j%cols)*500,(j//cols)*660))
        sheet.save(RENDER/f'{file.stem}-grid-{offset//6+1}.png')
    texts=[p.extract_text()or''for p in reader.pages]
    report['pdf'].append({'file':file.name,'pages':len(reader.pages),'bytes':file.stat().st_size,'text_chars':[len(t)for t in texts],'rendered':len(pages)})
    if file.stem not in ['ERD','시스템아키텍처']and any(len(t)<20 for t in texts):report['issues'].append({'empty_or_tiny_page':file.name})
db=sqlite3.connect(ROOT/'fixtures/demo.sqlite');integrity=db.execute('PRAGMA integrity_check').fetchone()[0];counts={t:db.execute('SELECT COUNT(*) FROM '+t).fetchone()[0]for t in ['users','sessions','metrics','servers']};sources=[r[0]for r in db.execute('SELECT DISTINCT source FROM metrics')];db.close()
report['demo_db']={'integrity':integrity,'counts':counts,'metric_sources':sources}
if integrity!='ok'or counts['users']or counts['sessions']or sources!=['demo']:report['issues'].append('데모 DB 조건 실패')
(E/'artifact-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps({'office_files':len(report['ooxml']),'pdf_files':len(report['pdf']),'pdf_pages':sum(x['pages']for x in report['pdf']),'issues':report['issues']},ensure_ascii=False))
if report['issues']:raise SystemExit(1)
