"""Word가 열 수 있는 문서도 엄격한 OOXML 스키마에 맞게 정규화합니다."""
from pathlib import Path
import sys
from docx import Document
from docx.oxml.ns import qn

directory=Path(sys.argv[1])
later=['shd','tabs','suppressAutoHyphens','kinsoku','wordWrap','overflowPunct','topLinePunct','autoSpaceDE','autoSpaceDN','bidi','adjustRightInd','snapToGrid','spacing','ind','contextualSpacing','mirrorIndents','suppressOverlap','jc','textDirection','textAlignment','textboxTightWrap','outlineLvl','divId','cnfStyle','rPr','sectPr','pPrChange']
for file in directory.glob('*.docx'):
    doc=Document(file)
    zoom=doc.settings.element.find(qn('w:zoom'))
    if zoom is not None and zoom.get(qn('w:percent'))is None:zoom.set(qn('w:percent'),'100')
    for root in [doc.element,doc.styles.element]:
        for pr in root.iter(qn('w:pPr')):
            for border in list(pr.findall(qn('w:pBdr'))):
                pr.remove(border);pr.insert_element_before(border,*['w:'+x for x in later])
    doc.save(file)
print('DOCX 확대율 및 문단 테두리 순서 정규화 완료')
