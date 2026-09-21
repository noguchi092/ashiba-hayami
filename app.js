import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const $ = id => document.getElementById(id);
const COLORS = {1829:"#1684f8",1524:"#00a88f",1219:"#6f63e8",914:"#e88b18",610:"#dd4e68"};
const POST_SIZES=[3800,2850,1900,1425,950,475],LOWER_POST_SIZES=[2750,1425,950,475,238];
const BASE_SCALE = 1.25, KEY = "ashiba-hayami-v1";
const columnPlanCache=new Map();
let blocks=[],history=[],future=[],selectedId=null,selectedIds=new Set(),tool="add",placementStair=false;
let span=1829,width=610,defaultFL=700,buildingFLs=[0],defaultBaseHeight=0,defaultFloorCount=1,drawingScale=100,mmPerPx=28.222,zoom=1;
let pdfDoc=null,pdfSourceBytes=null,pdfSourceName="",pageNumber=1,pageCount=0,baseStage={width:1120,height:760};
let jwwDoc=null,jwwRuntimePromise=null,jwwView=null,drawingKind=null;
let calibrationPoints=[],drag=null,range=null,series=null,resize=null,pan=null,renderTask=null,fitOnNextRender=false,panelCollapsed=true,suppressNextClick=false;
let wheelTimer=null,pendingWheelZoom=null,wheelAnchor=null,levelApplyTimer=null;
const quantityCollapsed=new Set(["支柱","根がらみ材","作業床材","手摺","昇降"]);

const stage=$("stage"),layer=$("blocksLayer"),postsLayer=$("postsLayer"),selectionLayer=$("selectionLayer"),calLayer=$("calibrationLayer"),canvas=$("pdfCanvas"),canvasScroll=$("canvasScroll");
const uid=()=>Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
const status=message=>{$("status").textContent=message;$("ratio").textContent=mmPerPx.toFixed(2)+" mm / px"};
const firstFloorHeight=b=>Math.max(0,Number(b.firstFloorFL??b.fl??0)-Number(b.baseHeight??0));
const floorCountOf=b=>Math.max(1,Math.round(Number(b.floorCount)||1));
const workFloorHeights=b=>Array.from({length:floorCountOf(b)},(_,i)=>firstFloorHeight(b)+i*1900);
const scaffoldHeight=b=>workFloorHeights(b).at(-1)??0;
const liftCount=b=>Math.max(0,floorCountOf(b)-1);
const normalizeBlock=b=>{
  const baseHeight=Number(b.baseHeight??0),legacyLevels=Array.isArray(b.floorFLs)?b.floorFLs.map(Number).filter(Number.isFinite):[],firstFloorFL=Number(b.firstFloorFL??legacyLevels[0]??b.fl??(700+baseHeight)),floorCount=Math.max(1,Math.round(Number(b.floorCount)||legacyLevels.length||1)),fl=firstFloorFL+(floorCount-1)*1900;
  return{...b,firstFloorFL,floorCount,fl,baseHeight,height:Math.max(0,fl-baseHeight),outerProtection:b.outerProtection??"handrail",innerProtection:b.innerProtection??"handrail",hasStair:Boolean(b.hasStair)&&Number(b.span)===1829&&floorCount>1};
};
const saveLocal=()=>localStorage.setItem(KEY,JSON.stringify({blocks,mmPerPx,drawingScale,defaultFL,buildingFLs,defaultBaseHeight,defaultFloorCount,panelCollapsed,levelSettingsApplyAll:true,workFloorBasisV2:true,separateBuildingFLs:true}));
const setSectionOpen=(id,open)=>{
  const section=$(id);if(!section)return;
  section.classList.toggle("open",open);const toggle=section.querySelector(".section-toggle"),mark=section.querySelector(".section-chevron");
  toggle?.setAttribute("aria-expanded",String(open));if(mark)mark.textContent=open?"−":"＋";
};
const setTool=next=>{
  tool=next;stage.classList.remove("tool-add","tool-select","tool-calibrate");stage.classList.add("tool-"+next);
  $("selectMode").classList.toggle("active",next==="select");$("placeMode").classList.toggle("active",next==="add");
  $("calibrate").classList.toggle("primary",next==="calibrate");
};
const commit=next=>{
  history=[...history.slice(-39),structuredClone(blocks)];future=[];blocks=next.map(normalizeBlock);
  saveLocal();renderBlocks();updateSummary();
};
const point=event=>{const r=stage.getBoundingClientRect();return{x:(event.clientX-r.left)/zoom,y:(event.clientY-r.top)/zoom}};
const dimensions=b=>({w:(b.rotation===0?b.span:b.width)/mmPerPx,h:(b.rotation===0?b.width:b.span)/mmPerPx});
const corners=b=>{const{w,h}=dimensions(b);return[[b.x,b.y],[b.x+w,b.y],[b.x,b.y+h],[b.x+w,b.y+h]]};
const rectangle=(a,b)=>({left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)});
const selectedBlocks=()=>blocks.filter(b=>selectedIds.has(b.id));

function uniquePostPositions(){
  const positions=new Map();
  blocks.forEach(b=>corners(b).forEach(([x,y])=>{
    const key=Math.round(x*1000)+","+Math.round(y*1000),current=positions.get(key);
    if(current){
      if(selectedIds.has(b.id))current.selected=true;
      current.baseHeight=Math.min(current.baseHeight,Number(b.baseHeight||0));
      if(scaffoldHeight(b)>current.height){current.fl=Number(b.fl||0);current.height=scaffoldHeight(b);current.firstHeight=firstFloorHeight(b);current.floorCount=floorCountOf(b)}
    }else positions.set(key,{x,y,selected:selectedIds.has(b.id),baseHeight:Number(b.baseHeight||0),fl:Number(b.fl||0),height:scaffoldHeight(b),firstHeight:firstFloorHeight(b),floorCount:floorCountOf(b)});
  }));
  return[...positions.values()];
}

function planEdgeSegments(sourceBlocks=blocks){
  const lines=new Map();
  sourceBlocks.forEach(b=>{
    const c=corners(b),horizontalKind=Number(b.rotation)===0?"long":"end",verticalKind=Number(b.rotation)===0?"end":"long";
    [[c[0],c[1],"h",horizontalKind],[c[2],c[3],"h",horizontalKind],[c[0],c[2],"v",verticalKind],[c[1],c[3],"v",verticalKind]].forEach(([start,end,axis,kind])=>{
      const fixed=Math.round((axis==="h"?start[1]:start[0])*1000),a=axis==="h"?start[0]:start[1],z=axis==="h"?end[0]:end[1],lo=Math.min(a,z),hi=Math.max(a,z),key=axis+":"+fixed;
      if(!lines.has(key))lines.set(key,[]);lines.get(key).push({lo,hi,kind});
    });
  });
  const standard=[1829,1524,1219,914,610,600,475];
  const nearestRail=mm=>standard.find(size=>Math.abs(size-mm)<10)??Math.round(mm);
  const edges=[];
  lines.forEach(segments=>{
    const points=[...new Set(segments.flatMap(segment=>[segment.lo,segment.hi]).map(v=>Math.round(v*1000)))].sort((a,z)=>a-z);
    for(let i=0;i<points.length-1;i++){
      const lo=points[i]/1000,hi=points[i+1]/1000,mid=(lo+hi)/2,covering=segments.filter(segment=>mid>segment.lo-0.001&&mid<segment.hi+0.001);
      if(covering.length)edges.push({size:nearestRail((hi-lo)*mmPerPx),kind:covering[0].kind,coverage:covering.length});
    }
  });
  return edges;
}
const uniquePlanEdges=(sourceBlocks=blocks)=>planEdgeSegments(sourceBlocks);
const exposedEndEdges=(sourceBlocks=blocks)=>planEdgeSegments(sourceBlocks).filter(edge=>edge.kind==="end"&&edge.coverage===1);

function solveColumn(rawHeight){
  const height=Math.round(Math.max(0,Number(rawHeight)||0));
  if(columnPlanCache.has(height))return columnPlanCache.get(height);
  if(Math.abs(height-700)<=25){
    const standard700={lower:238,regular:[475],jack:325,pieces:2,standard:0};columnPlanCache.set(height,standard700);return standard700;
  }
  const maxRegular=Math.max(0,height-Math.min(...LOWER_POST_SIZES)-45),plans=new Map([[0,[]]]);
  for(let sum=0;sum<=maxRegular;sum++){
    const plan=plans.get(sum);if(!plan)continue;
    POST_SIZES.forEach(size=>{
      const next=sum+size;if(next>maxRegular)return;
      const candidate=[...plan,size],existing=plans.get(next);
      const candidate1900=candidate.filter(v=>v===1900).length,existing1900=existing?.filter(v=>v===1900).length??-1;
      if(!existing||candidate.length<existing.length||(candidate.length===existing.length&&candidate1900>existing1900))plans.set(next,candidate);
    });
  }
  const candidates=[];
  LOWER_POST_SIZES.forEach(lower=>plans.forEach((regular,regularTotal)=>{
    const jack=height-lower-regularTotal;
    if(jack>=45&&jack<=345)candidates.push({lower,regular,jack,pieces:regular.length+1,standard:regular.filter(v=>v===1900).length});
  }));
  candidates.sort((a,b)=>a.pieces-b.pieces||b.lower-a.lower||b.standard-a.standard||Math.abs(a.jack-150)-Math.abs(b.jack-150));
  const result=candidates[0]||null;columnPlanCache.set(height,result);return result;
}

function verticalBreakdown(posts){
  const lower=new Map(),regular=new Map(),jacks=new Map();let unresolved=0;
  posts.forEach(post=>{
    const plan=solveColumn(post.firstHeight);if(!plan){unresolved++;return}
    lower.set(plan.lower,(lower.get(plan.lower)||0)+1);
    plan.regular.forEach(size=>regular.set(size,(regular.get(size)||0)+1));
    for(let i=1;i<post.floorCount;i++)regular.set(1900,(regular.get(1900)||0)+1);
    regular.set(950,(regular.get(950)||0)+1);
    jacks.set(plan.jack,(jacks.get(plan.jack)||0)+1);
  });
  const rows=[];
  [...lower].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["下部支柱 "+size,"IQ下部支柱",count,"本"]));
  [...regular].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["支柱 "+size,"IQ支柱",count,"本"]));
  [...jacks].sort((a,b)=>a[0]-b[0]).forEach(([useHeight,count])=>rows.push(["HPJ5-450","使用高さ "+useHeight+"mm",count,"本"]));
  if(unresolved)rows.push(["支柱構成 要確認","規格内で構成できない高さ",unresolved,"箇所"]);
  return rows;
}

function connectedBlockGroups(){
  const remaining=new Set(blocks.map(b=>b.id)),groups=[];
  while(remaining.size){
    const first=remaining.values().next().value,queue=[first],group=[];remaining.delete(first);
    while(queue.length){
      const id=queue.shift(),block=blocks.find(b=>b.id===id);if(!block)continue;group.push(block);
      blocks.forEach(other=>{if(!remaining.has(other.id))return;const touches=corners(block).some(a=>corners(other).some(b=>Math.hypot(a[0]-b[0],a[1]-b[1])<.01));if(touches){remaining.delete(other.id);queue.push(other.id)}});
    }
    groups.push(group);
  }
  return groups;
}
const overlapArea=(a,b)=>{
  const ad=dimensions(a),bd=dimensions(b);
  return Math.max(0,Math.min(a.x+ad.w,b.x+bd.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+ad.h,b.y+bd.h)-Math.max(a.y,b.y));
};
function snapBlock(candidate,excludeId=null){
  const threshold=18/zoom,candidateCorners=corners(candidate);let best=null;
  blocks.filter(b=>b.id!==excludeId).forEach(other=>corners(other).forEach(target=>candidateCorners.forEach(source=>{
    const dx=target[0]-source[0],dy=target[1]-source[1],distance=Math.hypot(dx,dy);
    if(distance>threshold||(best&&distance>=best.distance))return;
    const snapped={...candidate,x:Math.max(0,candidate.x+dx),y:Math.max(0,candidate.y+dy)};
    if(overlapArea(snapped,other)>1)return;best={block:snapped,distance};
  })));
  return best?{block:best.block,snapped:true}:{block:candidate,snapped:false};
}

async function loadPdf(file){
  try{
    status("PDFを読み込んでいます…");
    const source=new Uint8Array(await file.arrayBuffer());pdfSourceBytes=source.slice();pdfSourceName=file.name||"drawing.pdf";drawingKind="pdf";jwwDoc=null;jwwView=null;
    pdfDoc=await pdfjsLib.getDocument({data:source}).promise;
    pageCount=pdfDoc.numPages;pageNumber=1;$("pdfName").textContent=file.name;$("pdfHelp").textContent=pageCount+"ページ";
    $("pageNav").classList.toggle("hidden",pageCount<2);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;fitOnNextRender=true;
    await renderPdf();setSectionOpen("drawingSection",false);setSectionOpen("scaleSection",true);status(file.name+" を読み込みました（全体表示）");
  }catch(error){console.error(error);status("PDFを読み込めませんでした。別のPDFでお試しください")}
}

const JWW_WASM_URL="https://cdn.jsdelivr.net/gh/ArchivierteRepositories/jww-parser@b919877eb4d1ae9fa0b773d70025f27f8316ea48/wasm/public/jww-parser.wasm";
async function ensureJwwRuntime(){
  if(typeof window.jwwParse==="function")return;
  if(jwwRuntimePromise)return jwwRuntimePromise;
  jwwRuntimePromise=(async()=>{
    if(typeof window.Go!=="function")throw new Error("JWW解析機能を読み込めませんでした");
    const go=new window.Go(),response=await fetch(JWW_WASM_URL);
    if(!response.ok)throw new Error("JWW解析データを取得できませんでした");
    const bytes=await response.arrayBuffer(),result=await WebAssembly.instantiate(bytes,go.importObject);
    go.run(result.instance);
    for(let i=0;i<50&&typeof window.jwwParse!=="function";i++)await new Promise(resolve=>setTimeout(resolve,20));
    if(typeof window.jwwParse!=="function")throw new Error("JWW解析機能を開始できませんでした");
  })();
  try{await jwwRuntimePromise}catch(error){jwwRuntimePromise=null;throw error}
}
const numberOf=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
function transformJwwEntity(entity,transform={x:0,y:0,sx:1,sy:1,rotation:0}){
  const point=(x,y)=>{const px=numberOf(x)*transform.sx,py=numberOf(y)*transform.sy,c=Math.cos(transform.rotation),s=Math.sin(transform.rotation);return{x:transform.x+px*c-py*s,y:transform.y+px*s+py*c}};
  const result={...entity};
  [["StartX","StartY"],["EndX","EndY"],["CenterX","CenterY"],["X","Y"],["Point1X","Point1Y"],["Point2X","Point2Y"],["Point3X","Point3Y"],["Point4X","Point4Y"]].forEach(([xKey,yKey])=>{
    if(xKey in entity&&yKey in entity){const p=point(entity[xKey],entity[yKey]);result[xKey]=p.x;result[yKey]=p.y}
  });
  if("Radius" in result)result.Radius=Math.abs(numberOf(result.Radius)*transform.sx);
  if("Flatness" in result)result.Flatness=numberOf(result.Flatness,1)*Math.abs(transform.sy/transform.sx);
  if("TiltAngle" in result)result.TiltAngle=numberOf(result.TiltAngle)+transform.rotation;
  if("Angle" in result&&"Content" in result)result.Angle=numberOf(result.Angle)+transform.rotation*180/Math.PI;
  return result;
}
function flattenJwwDocument(doc){
  const defs=new Map((doc.BlockDefs||[]).map(def=>[Number(def.Number),def])),output=[];
  const visit=(entities,transform={x:0,y:0,sx:1,sy:1,rotation:0},depth=0)=>{
    if(depth>8)return;
    (entities||[]).forEach(entity=>{
      if("DefNumber" in entity){
        const ref=transformJwwEntity({X:entity.RefX,Y:entity.RefY},transform),def=defs.get(Number(entity.DefNumber));
        if(def)visit(def.Entities,{x:ref.X,y:ref.Y,sx:transform.sx*numberOf(entity.ScaleX,1),sy:transform.sy*numberOf(entity.ScaleY,1),rotation:transform.rotation+numberOf(entity.Rotation)},depth+1);
      }else output.push(transformJwwEntity(entity,transform));
    });
  };
  visit(doc.Entities);return output;
}
function jwwEntityPoints(entity){
  if("StartX" in entity&&"EndX" in entity)return[[entity.StartX,entity.StartY],[entity.EndX,entity.EndY]];
  if("CenterX" in entity&&"Radius" in entity){
    const points=[],steps=entity.IsFullCircle?72:Math.max(12,Math.ceil(Math.abs(numberOf(entity.ArcAngle))*18/Math.PI)),start=numberOf(entity.StartAngle),arc=entity.IsFullCircle?Math.PI*2:numberOf(entity.ArcAngle),tilt=numberOf(entity.TiltAngle),flat=numberOf(entity.Flatness,1),radius=Math.abs(numberOf(entity.Radius));
    for(let i=0;i<=steps;i++){const a=start+arc*i/steps,x=radius*Math.cos(a),y=radius*flat*Math.sin(a),c=Math.cos(tilt),s=Math.sin(tilt);points.push([numberOf(entity.CenterX)+x*c-y*s,numberOf(entity.CenterY)+x*s+y*c])}return points;
  }
  if("Point1X" in entity)return[[entity.Point1X,entity.Point1Y],[entity.Point2X,entity.Point2Y],[entity.Point3X,entity.Point3Y],[entity.Point4X,entity.Point4Y]];
  if("X" in entity)return[[entity.X,entity.Y]];
  return[];
}
function prepareJwwView(doc){
  const entities=flattenJwwDocument(doc),allPoints=entities.flatMap(jwwEntityPoints);
  entities.filter(entity=>"Content" in entity).forEach(entity=>allPoints.push([entity.StartX,entity.StartY],[entity.EndX,entity.EndY]));
  if(!allPoints.length)throw new Error("表示できる線や文字がありません");
  const xs=allPoints.map(point=>numberOf(point[0])),ys=allPoints.map(point=>numberOf(point[1])),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),worldWidth=Math.max(1,maxX-minX),worldHeight=Math.max(1,maxY-minY),margin=36;
  baseStage={width:1120,height:760};const scale=Math.min((baseStage.width-margin*2)/worldWidth,(baseStage.height-margin*2)/worldHeight);
  mmPerPx=1/scale;
  return{entities,minX,maxX,minY,maxY,scale,offsetX:(baseStage.width-worldWidth*scale)/2,offsetY:(baseStage.height-worldHeight*scale)/2};
}
function renderJww(){
  if(!jwwDoc||!jwwView)return;
  const ratio=window.devicePixelRatio||1,viewWidth=baseStage.width*zoom,viewHeight=baseStage.height*zoom,ctx=canvas.getContext("2d"),map=(x,y)=>({x:(jwwView.offsetX+(numberOf(x)-jwwView.minX)*jwwView.scale)*zoom,y:(jwwView.offsetY+(jwwView.maxY-numberOf(y))*jwwView.scale)*zoom});
  stage.style.width=viewWidth+"px";stage.style.height=viewHeight+"px";canvas.width=Math.floor(viewWidth*ratio);canvas.height=Math.floor(viewHeight*ratio);canvas.style.width=viewWidth+"px";canvas.style.height=viewHeight+"px";ctx.setTransform(ratio,0,0,ratio,0,0);ctx.fillStyle="#fff";ctx.fillRect(0,0,viewWidth,viewHeight);ctx.lineCap="round";ctx.lineJoin="round";
  jwwView.entities.forEach(entity=>{
    const points=jwwEntityPoints(entity),lineWidth=Math.max(.55,Math.min(2.2,numberOf(entity.PenWidth,1)/5))*zoom;ctx.strokeStyle="#263b4c";ctx.fillStyle="#263b4c";ctx.lineWidth=lineWidth;
    if("Content" in entity){const p=map(entity.StartX,entity.StartY),size=Math.max(6,Math.min(24,numberOf(entity.SizeY,3)*jwwView.scale*zoom));ctx.save();ctx.translate(p.x,p.y);ctx.rotate(-numberOf(entity.Angle)*Math.PI/180);ctx.font=`${size}px sans-serif`;ctx.textBaseline="alphabetic";ctx.fillText(String(entity.Content||""),0,0);ctx.restore();return}
    if("Point1X" in entity&&points.length){ctx.beginPath();points.forEach((point,index)=>{const p=map(point[0],point[1]);index?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});ctx.closePath();ctx.fillStyle="#9bacb833";ctx.fill();ctx.stroke();return}
    if("X" in entity&&points.length){const p=map(points[0][0],points[0][1]),r=3*zoom;ctx.beginPath();ctx.moveTo(p.x-r,p.y);ctx.lineTo(p.x+r,p.y);ctx.moveTo(p.x,p.y-r);ctx.lineTo(p.x,p.y+r);ctx.stroke();return}
    if(points.length>1){ctx.beginPath();points.forEach((point,index)=>{const p=map(point[0],point[1]);index?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});if(entity.IsFullCircle)ctx.closePath();ctx.stroke()}
  });
  canvas.classList.add("visible");$("emptyPlan").classList.add("hidden");setStageSize();
}
async function loadJww(file){
  try{
    status("JWW解析機能を準備しています…");await ensureJwwRuntime();status("JWW図面を読み込んでいます…");
    const source=new Uint8Array(await file.arrayBuffer()),result=window.jwwParse(source);
    if(!result?.ok||!result.data)throw new Error(result?.error||"JWWを解析できませんでした");
    const doc=JSON.parse(result.data);try{renderTask?.cancel?.()}catch{}pdfDoc=null;renderTask=null;jwwDoc=doc;jwwView=prepareJwwView(doc);drawingKind="jww";pdfSourceBytes=source.slice();pdfSourceName=file.name||"drawing.jww";pageNumber=1;pageCount=1;$("pageNav").classList.add("hidden");$("pdfName").textContent=pdfSourceName;$("pdfHelp").textContent=(doc.Entities?.length||0).toLocaleString()+"要素・JWW Ver."+(doc.Version||"-");fitOnNextRender=true;
    const scroll=$("canvasScroll");zoom=Math.max(.35,Math.min(2.5,(scroll.clientWidth-32)/baseStage.width,(scroll.clientHeight-32)/baseStage.height));fitOnNextRender=false;$("zoomLabel").textContent=Math.round(zoom*100)+"%";renderJww();renderBlocks();setSectionOpen("drawingSection",false);setSectionOpen("scaleSection",true);status(pdfSourceName+" を読み込みました（JWW・実寸座標）");
  }catch(error){console.error(error);status("JWWを読み込めませんでした。Jw_cadで保存し直してお試しください")}
}
async function loadDrawingFile(file){
  const lower=file.name.toLowerCase();if(lower.endsWith(".jww"))return loadJww(file);return loadPdf(file);
}
async function renderPdf(){
  if(!pdfDoc)return;try{renderTask?.cancel?.()}catch{}
  const page=await pdfDoc.getPage(pageNumber),base=page.getViewport({scale:BASE_SCALE});
  baseStage={width:base.width,height:base.height};
  if(fitOnNextRender){
    const scroll=$("canvasScroll");
    zoom=Math.max(.35,Math.min(2.5,(scroll.clientWidth-32)/baseStage.width,(scroll.clientHeight-32)/baseStage.height));
    fitOnNextRender=false;$("zoomLabel").textContent=Math.round(zoom*100)+"%";
  }
  const view=page.getViewport({scale:BASE_SCALE*zoom});setStageSize();
  const ratio=window.devicePixelRatio||1,ctx=canvas.getContext("2d");
  canvas.width=Math.floor(view.width*ratio);canvas.height=Math.floor(view.height*ratio);
  canvas.style.width=view.width+"px";canvas.style.height=view.height+"px";ctx.setTransform(ratio,0,0,ratio,0,0);
  renderTask=page.render({canvasContext:ctx,viewport:view});
  try{await renderTask.promise}catch(error){if(error?.name==="RenderingCancelledException")return;throw error}
  canvas.classList.add("visible");$("emptyPlan").classList.add("hidden");$("pageLabel").textContent=pageNumber+" / "+pageCount;
}
async function fitToView(){
  const scroll=$("canvasScroll");
  zoom=Math.max(.35,Math.min(2.5,(scroll.clientWidth-32)/baseStage.width,(scroll.clientHeight-32)/baseStage.height));
  $("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():jwwDoc?renderJww():setStageSize();
}
function setStageSize(){
  stage.style.width=baseStage.width*zoom+"px";stage.style.height=baseStage.height*zoom+"px";renderBlocks();renderCalibration();
}
async function applyZoom(nextZoom,anchor=null){
  const next=Math.max(.35,Math.min(2.5,+nextZoom.toFixed(2)));if(next===zoom)return;
  const rect=canvasScroll.getBoundingClientRect(),localX=anchor?anchor.clientX-rect.left:canvasScroll.clientWidth/2,localY=anchor?anchor.clientY-rect.top:canvasScroll.clientHeight/2;
  const contentX=canvasScroll.scrollLeft+localX,contentY=canvasScroll.scrollTop+localY,previous=zoom;zoom=next;
  $("zoomLabel").textContent=Math.round(zoom*100)+"%";pdfDoc?await renderPdf():jwwDoc?renderJww():setStageSize();
  const factor=zoom/previous;canvasScroll.scrollLeft=Math.max(0,contentX*factor-localX);canvasScroll.scrollTop=Math.max(0,contentY*factor-localY);
}
function renderBlocks(){
  layer.innerHTML="";
  blocks.forEach(b=>{
    const{w,h}=dimensions(b),selected=selectedIds.has(b.id),el=document.createElement("button");
    el.className="scaffold-block"+(selected?" selected":"")+(selected&&selectedIds.size>1?" multi-selected":"")+(b.hasStair?" has-stair":"");el.dataset.id=b.id;
    Object.assign(el.style,{left:b.x*zoom+"px",top:b.y*zoom+"px",width:w*zoom+"px",height:h*zoom+"px",borderColor:COLORS[b.span],backgroundColor:COLORS[b.span]+"30","--c":COLORS[b.span]});
    el.innerHTML='<span class="block-size">'+b.span+" × "+b.width+(b.hasStair?' <em>階段</em>':'')+"</span><span class=\"resize-handle\" title=\"横方向へ延長\" aria-label=\"横方向へ延長\"></span>";
    const handle=el.querySelector(".resize-handle");
    handle.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();const p=point(e),size=dimensions(b);resize={id:b.id,start:p,current:p,origin:{...b},w:size.w,h:size.h};stage.classList.add("series-placing");stage.setPointerCapture(e.pointerId);renderResizePreview()});
    el.addEventListener("pointerdown",e=>{
      if(e.button!==0)return;e.stopPropagation();if(!selectedIds.has(b.id))selectBlocks([b.id]);setTool("select");
      const p=point(e);history=[...history.slice(-39),structuredClone(blocks)];future=[];
      const ids=[...selectedIds];drag={ids,start:p,origins:new Map(ids.map(id=>{const item=blocks.find(v=>v.id===id);return[id,{x:item.x,y:item.y}]}))};
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("click",e=>e.stopPropagation());layer.appendChild(el);
  });
  renderPosts();$("undo").disabled=!history.length;$("redo").disabled=!future.length;
}
function renderPosts(){
  postsLayer.innerHTML="";
  uniquePostPositions().forEach(p=>{const el=document.createElement("i");el.className="post-dot"+(p.selected?" selected-post":"");el.style.left=p.x*zoom+"px";el.style.top=p.y*zoom+"px";postsLayer.appendChild(el)});
}
function renderCalibration(){
  calLayer.innerHTML="";
  calibrationPoints.forEach((p,i)=>{const el=document.createElement("span");el.className="cal-point";el.style.left=p.x*zoom+"px";el.style.top=p.y*zoom+"px";el.textContent=i+1;calLayer.appendChild(el)});
}
function renderRange(){
  selectionLayer.innerHTML="";if(!range)return;
  const r=rectangle(range.start,range.current),el=document.createElement("div");el.className="marquee";
  Object.assign(el.style,{left:r.left*zoom+"px",top:r.top*zoom+"px",width:(r.right-r.left)*zoom+"px",height:(r.bottom-r.top)*zoom+"px"});selectionLayer.appendChild(el);
}
function seriesCount(data){return Math.min(100,Math.max(1,Math.round(Math.abs(data.current.x-data.start.x)/data.w)+1))}
function renderSeries(){
  selectionLayer.innerHTML="";if(!series)return;
  const count=seriesCount(series),direction=series.current.x>=series.start.x?1:-1;
  for(let i=0;i<count;i++){
    const el=document.createElement("div");el.className="series-preview";
    Object.assign(el.style,{left:(series.start.x-series.w/2+i*direction*series.w)*zoom+"px",top:(series.start.y-series.d/2)*zoom+"px",width:series.w*zoom+"px",height:series.d*zoom+"px",borderColor:COLORS[series.span]});selectionLayer.appendChild(el);
  }
  status(count+"区画を連続配置します");
}
function resizeCount(data){return Math.min(100,Math.max(1,Math.round(Math.abs(data.current.x-data.start.x)/data.w)))}
function renderResizePreview(){
  selectionLayer.innerHTML="";if(!resize)return;
  const count=resizeCount(resize),direction=resize.current.x>=resize.start.x?1:-1;
  for(let i=1;i<=count;i++){
    const el=document.createElement("div");el.className="series-preview resize-preview";
    Object.assign(el.style,{left:(resize.origin.x+direction*i*resize.w)*zoom+"px",top:resize.origin.y*zoom+"px",width:resize.w*zoom+"px",height:resize.h*zoom+"px",borderColor:COLORS[resize.origin.span]});selectionLayer.appendChild(el);
  }
  status(count+"区画を右下ハンドルから延長します");
}
function selectBlocks(ids){
  selectedIds=new Set(ids.filter(id=>blocks.some(b=>b.id===id)));selectedId=[...selectedIds].at(-1)??null;renderBlocks();updateSelectionEditor();
}
function selectBlock(id){selectBlocks(id?[id]:[])}
function sectionPostAllocation(block){
  const first=Math.round(firstFloorHeight(block)),parts=[];
  const plan=solveColumn(first);
  if(plan){
    parts.push({label:"下部支柱 "+plan.lower,weight:plan.lower});
    plan.regular.forEach(size=>parts.push({label:"支柱 "+size,weight:size}));
  }else parts.push({label:"下部構成 要確認",weight:Math.max(first,1)});
  for(let i=1;i<floorCountOf(block);i++)parts.push({label:"支柱 1900",weight:1900});
  parts.push({label:"支柱 950",weight:950});
  return parts;
}
function renderSelectionSection(selected){
  const sourceItems=[...(Array.isArray(selected)?selected:[selected])];
  const bounds=sourceItems.map(block=>{const size=dimensions(block);return{block,left:block.x,top:block.y,right:block.x+size.w,bottom:block.y+size.h}}),extentX=Math.max(...bounds.map(v=>v.right))-Math.min(...bounds.map(v=>v.left)),extentY=Math.max(...bounds.map(v=>v.bottom))-Math.min(...bounds.map(v=>v.top)),sectionAxis=extentX>=extentY?"x":"y";
  const sectionLength=block=>sectionAxis==="x"?(block.rotation===0?Number(block.span):Number(block.width)):(block.rotation===0?Number(block.width):Number(block.span));
  const items=sourceItems.sort((a,b)=>(sectionAxis==="x"?a.x:a.y)-(sectionAxis==="x"?b.x:b.y));
  const preview=$("selectionSectionView"),totalSpan=items.reduce((sum,b)=>sum+sectionLength(b),0);
  const floorLevels=[...new Set(items.flatMap(block=>workFloorHeights(block).map(height=>Number(block.baseHeight||0)+height)))].sort((a,b)=>a-b),buildingLevels=buildingFLs.map(Number).filter(Number.isFinite);
  const minBase=Math.min(...items.map(block=>Number(block.baseHeight||0))),chartMin=Math.min(0,minBase,...buildingLevels),upperLevels=items.map(block=>Number(block.fl)+900),maxUpper=Math.max(...upperLevels,...buildingLevels,chartMin+1);
  const bottom=138,top=20,left=92,right=242,usable=bottom-top,yAtFL=level=>bottom-((level-chartMin)/(maxUpper-chartMin))*usable;let cursor=left;
  const bays=items.map((block,index)=>{
    const bayLength=sectionLength(block),x1=cursor,x2=index===items.length-1?right:cursor+(right-left)*bayLength/totalSpan;cursor=x2;
    const base=Number(block.baseHeight||0),blockFloorLevels=workFloorHeights(block).map(height=>base+height);
    const floors=blockFloorLevels.map((level,floorIndex)=>{const y=yAtFL(level),r450=yAtFL(level+450),r900=yAtFL(level+900),lower=floorIndex>0?blockFloorLevels[floorIndex-1]:null;return`<line class="section-floor" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/><line class="section-handrail" x1="${x1}" y1="${r450}" x2="${x2}" y2="${r450}"/><line class="section-handrail" x1="${x1}" y1="${r900}" x2="${x2}" y2="${r900}"/>${block.hasStair&&lower!==null?`<line class="section-stair" x1="${x1+3}" y1="${yAtFL(lower)}" x2="${x2-3}" y2="${y}"/>`:""}`}).join("");
    return`<line class="section-post" x1="${x1}" y1="${yAtFL(Number(block.fl)+900)}" x2="${x1}" y2="${yAtFL(base)}"/>${index===items.length-1?`<line class="section-post" x1="${x2}" y1="${yAtFL(Number(block.fl)+900)}" x2="${x2}" y2="${yAtFL(base)}"/>`:""}${floors}<circle class="section-post-mark" cx="${x1}" cy="${yAtFL(base)}" r="2.3"/>${index===items.length-1?`<circle class="section-post-mark" cx="${x2}" cy="${yAtFL(base)}" r="2.3"/>`:""}<text class="section-bay-label" x="${(x1+x2)/2}" y="151" text-anchor="middle">${bayLength}</text>`;
  }).join("");
  const floorDimensions=floorLevels.map(level=>{const y=yAtFL(level);return`<line class="section-extension" x1="72" y1="${y}" x2="${left-3}" y2="${y}"/><line class="section-level-tick" x1="69" y1="${y}" x2="75" y2="${y}"/><text class="section-level-label" x="66" y="${y+3}" text-anchor="end">作業床高さ ${level.toLocaleString()}</text>`}).join("");
  const buildingDimensions=buildingLevels.map((level,index)=>{const y=yAtFL(level);return`<line class="section-building-level" x1="${left-8}" y1="${y}" x2="${right+8}" y2="${y}"/><rect class="section-building-level-label-bg" x="${right+9}" y="${y-10}" width="48" height="10" rx="2"/><text class="section-building-level-label" x="${right+11}" y="${y-3}">${index+1}FL ${level.toLocaleString()}mm</text>`}).join("");
  const topLevel=Math.max(...upperLevels),topY=yAtFL(topLevel),baseY=yAtFL(minBase),zeroY=yAtFL(0);
  const topLabelY=Math.max(16,topY+2);
  const allocationBlock=items.reduce((best,item)=>Number(item.fl)>Number(best.fl)?item:best,items[0]),allocationParts=sectionPostAllocation(allocationBlock),allocationTotal=allocationParts.reduce((sum,part)=>sum+part.weight,0)||1;
  let allocationY=baseY;
  const allocationSvg=allocationParts.map(part=>{const next=allocationY-(baseY-topY)*part.weight/allocationTotal,mid=(allocationY+next)/2,svgPart=`<line class="section-allocation" x1="292" y1="${allocationY}" x2="292" y2="${next}" marker-start="url(#sectionArrow)" marker-end="url(#sectionArrow)"/><line class="section-allocation-tick" x1="288" y1="${allocationY}" x2="296" y2="${allocationY}"/><text class="section-allocation-label" x="299" y="${mid+2}">${part.label}</text>`;allocationY=next;return svgPart}).join("")+`<line class="section-allocation-tick" x1="288" y1="${topY}" x2="296" y2="${topY}"/><text class="section-allocation-title" x="288" y="${Math.max(12,topY-6)}">支柱構成</text><text class="section-allocation-label" x="299" y="${baseY+10}">＋標準ジャッキ</text>`;
  const svg=`<svg viewBox="0 0 420 178" role="img" aria-label="長手方向 ${items.length}区画、合計${totalSpan}ミリ。作業床高さ、建物FL、支柱構成、足場上部レベルの寸法入り"><defs><marker id="sectionArrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" class="section-arrow"/></marker></defs><line class="section-ground" x1="${left-10}" y1="${baseY+3}" x2="${right+10}" y2="${baseY+3}"/><text class="section-surface-label" x="${left-12}" y="${baseY+13}" text-anchor="end">設置面</text>${chartMin<=0&&zeroY>=top&&zeroY<=bottom?`<line class="section-fl-zero" x1="72" y1="${zeroY}" x2="${right+10}" y2="${zeroY}"/><text class="section-fl-zero-label" x="66" y="${zeroY+3}" text-anchor="end">FL 0</text>`:""}${buildingDimensions}${floorDimensions}${bays}<text class="section-post-label" x="${left}" y="${top-3}">支柱位置（${items.length+1}箇所）</text>${allocationSvg}<line class="section-dimension" x1="350" y1="${baseY}" x2="350" y2="${topY}" marker-start="url(#sectionArrow)" marker-end="url(#sectionArrow)"/><line class="section-extension" x1="${right+3}" y1="${topY}" x2="354" y2="${topY}"/><line class="section-extension" x1="${right+3}" y1="${baseY}" x2="354" y2="${baseY}"/><rect class="section-upper-label-bg" x="358" y="${topLabelY-8}" width="58" height="20" rx="2"/><text class="section-height" x="360" y="${topLabelY}"><tspan x="360">上部 FL</tspan><tspan x="360" dy="9">${topLevel.toLocaleString()} mm</tspan></text><line class="section-dimension" x1="${left}" y1="160" x2="${right}" y2="160" marker-start="url(#sectionArrow)" marker-end="url(#sectionArrow)"/><line class="section-extension" x1="${left}" y1="${baseY+3}" x2="${left}" y2="164"/><line class="section-extension" x1="${right}" y1="${baseY+3}" x2="${right}" y2="164"/><text class="section-width" x="${(left+right)/2}" y="174" text-anchor="middle">合計 ${totalSpan.toLocaleString()} mm</text><text class="section-badge" x="${left}" y="11">${items.length}区画・作業床最大${Math.max(...items.map(floorCountOf))}層</text></svg>`;
  preview.innerHTML=svg;$("sectionModalView").innerHTML=svg;
}
function updateSelectionEditor(){
  const selected=selectedBlocks(),has=selected.length>0;$("selectionEmpty").classList.toggle("hidden",has);$("selectionEditor").classList.toggle("hidden",!has);
  $("selectionBadge").textContent=has?(selected.length===1?"1件選択":selected.length+"件選択"):"未選択";if(!has)return;
  const first=selected[0],same=key=>selected.every(b=>Number(b[key])===Number(first[key]));
  $("selectionSectionView").classList.remove("hidden");renderSelectionSection(selected);
  $("selectedColor").style.background=selected.length===1?COLORS[first.span]:"#e53253";
  $("selectedSpec").textContent=selected.length===1?first.span+" × "+first.width:selected.length+"件・合計"+selected.reduce((sum,b)=>sum+b.span,0).toLocaleString()+"mm";
  document.querySelector(".selected-spec small").textContent=selected.length===1?"mm":"";
  $("selectedFL").value=same("firstFloorFL")?first.firstFloorFL:"";$("selectedFL").placeholder=same("firstFloorFL")?"":"複数";
  $("selectedBaseHeight").value=same("baseHeight")?first.baseHeight:"";$("selectedBaseHeight").placeholder=same("baseHeight")?"":"複数";
  $("selectedFloorCount").value=same("floorCount")?first.floorCount:"";$("selectedFloorCount").placeholder=same("floorCount")?"":"複数";
  const upperLevels=selected.map(b=>Number(b.fl)+900),sameUpper=upperLevels.every(v=>v===upperLevels[0]);
  $("selectedActualHeight").textContent=sameUpper?"FL "+upperLevels[0].toLocaleString()+" mm":"複数";
  const tops=selected.map(scaffoldHeight),floorCounts=selected.map(floorCountOf);
  $("selectedLevels").textContent=tops.every(v=>v===tops[0])&&floorCounts.every(v=>v===floorCounts[0])?floorCounts[0]+"層（最上段"+tops[0].toLocaleString()+"mm）":"複数";
  $("selectedSpan").value=same("span")?String(first.span):"1829";$("selectedWidth").value=same("width")?String(first.width):"610";
  $("selectedKind").value=selected.every(b=>b.hasStair)?"stair":"normal";
}
function applyElevationChange(key,value){
  if(!selectedIds.size||value==="")return;const number=Number(value);
  commit(blocks.map(b=>{if(!selectedIds.has(b.id))return b;const changed={...b,[key]:number};return{...changed,height:scaffoldHeight(changed)}}));updateSelectionEditor();
}
function updateSummary(){
  const length=blocks.reduce((s,b)=>s+b.span,0)/1000,area=blocks.reduce((s,b)=>s+b.span/1000*scaffoldHeight(b)/1000,0);
  $("metricCount").textContent=blocks.length;$("metricLength").textContent=length.toFixed(1);$("metricArea").textContent=area.toFixed(1);
  const rows=quantities();$("csv").disabled=!rows.length;
  let currentGroup="";
  $("quantityBody").innerHTML=rows.length?rows.map(r=>{
    if(r[4]==="group"){
      currentGroup=r[0];const collapsed=quantityCollapsed.has(currentGroup);
      return`<tr class="quantity-group"><th colspan="2"><button type="button" class="quantity-group-toggle" data-quantity-toggle="${currentGroup}" aria-expanded="${!collapsed}"><span>${r[0]}${r[1]?`<small>${r[1]}</small>`:""}</span><i>${collapsed?"＋":"−"}</i></button></th></tr>`;
    }
    return`<tr class="quantity-item${quantityCollapsed.has(currentGroup)?" is-collapsed":""}" data-quantity-group="${currentGroup}"><td>${r[0]}<small>${r[1]}</small></td><td><strong>${r[2].toLocaleString()}</strong> ${r[3]}</td></tr>`;
  }).join(""):'<tr><td colspan="2" class="zero">足場を配置すると集計します</td></tr>';
}
function quantities(){
  if(!blocks.length)return[];
  const floorCount=floorCountOf,posts=uniquePostPositions(),postCount=posts.length;
  const rootTotals=new Map(),floorRailTotals=new Map(),workHandrails=new Map(),workBraces=new Map(),deckTotals=new Map(),floorLayers=new Map();let stairOpeningCount=0;
  uniquePlanEdges().forEach(edge=>rootTotals.set(edge.size,(rootTotals.get(edge.size)||0)+1));
  blocks.forEach(b=>{
    const count=floorCount(b),handrailSides=(b.outerProtection==="handrail"?1:0)+(b.innerProtection==="handrail"?1:0),braceSides=(b.outerProtection==="brace"?1:0)+(b.innerProtection==="brace"?1:0);
    workHandrails.set(b.span,(workHandrails.get(b.span)||0)+count*2*handrailSides);workBraces.set(b.span,(workBraces.get(b.span)||0)+count*braceSides);
    const boardWidths=b.width<=610?[490]:b.width<=914?[490,240]:[490,490],boardLanes=new Map();
    boardWidths.forEach(boardWidth=>boardLanes.set(boardWidth,(boardLanes.get(boardWidth)||0)+1));
    const stairOpenings=b.hasStair&&b.span===1829?Math.max(0,count-1):0;stairOpeningCount+=stairOpenings;
    boardLanes.forEach((lanes,boardWidth)=>{const key=b.span+"×"+boardWidth,quantity=Math.max(0,count*lanes-(boardWidth===490?stairOpenings:0));deckTotals.set(key,(deckTotals.get(key)||0)+quantity)});
    for(let i=0;i<count;i++){const level=Number(b.firstFloorFL)+i*1900;if(!floorLayers.has(level))floorLayers.set(level,[]);floorLayers.get(level).push(b)}
  });
  floorLayers.forEach(layerBlocks=>{
    uniquePlanEdges(layerBlocks).forEach(edge=>floorRailTotals.set(edge.size,(floorRailTotals.get(edge.size)||0)+1));
    exposedEndEdges(layerBlocks).forEach(edge=>workHandrails.set(edge.size,(workHandrails.get(edge.size)||0)+2));
  });
  const group=(name,detail="")=>[name,detail,0,"","group"],rows=[group("支柱","支柱位置 "+postCount+"箇所"),...verticalBreakdown(posts),group("根がらみ材")];
  [...rootTotals].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQ手すり "+size,"平面外周（接続部重複なし）",count,"本"]));
  rows.push(group("作業床材"));
  [...floorRailTotals].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQ手すり "+size,"作業床受け（同一床・接続部重複なし）",count,"本"]));
  [...deckTotals].sort((a,b)=>b[0].localeCompare(a[0],"ja",{numeric:true})).forEach(([size,count])=>rows.push(["布板 "+size,size==="1829×490"&&stairOpeningCount?"Sウォーク（階段開口 "+stairOpeningCount+"枚控除）":"Sウォーク",count,"枚"]));
  rows.push(group("手摺"));
  [...workHandrails].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQ手すり "+size,"各作業床450/900・長手／端部",count,"本"]));
  [...workBraces].sort((a,b)=>b[0]-a[0]).forEach(([size,count])=>rows.push(["IQブレス "+size,"各作業床・ブレス設定側",count,"本"]));
  const stairCount=stairOpeningCount;
  rows.push(group("昇降"),["階段 1900","IQアルミカイダン19",stairCount,"基"],["階段手すり","IQカイダンレール",stairCount,"本"]);return rows;
}
function renderLevelRows(){
  const wrap=$("levelRows");if(!wrap)return;
  buildingFLs=buildingFLs.length?buildingFLs:[0];
  wrap.innerHTML=buildingFLs.map((level,index)=>`<div class="level-row"><label>${index+1}FL（mm）</label><input type="number" step="100" data-level-index="${index}" value="${Number(level)||0}">${index?`<button type="button" class="mini-remove" data-remove-level="${index}" aria-label="${index+1}FLを削除">×</button>`:""}</div>`).join("");
  wrap.querySelectorAll("[data-level-index]").forEach(input=>input.addEventListener("input",()=>{buildingFLs=[...wrap.querySelectorAll("[data-level-index]")].map(el=>Number(el.value)||0);saveLocal();updateSelectionEditor()}));
  wrap.querySelectorAll("[data-remove-level]").forEach(button=>button.addEventListener("click",()=>{buildingFLs.splice(Number(button.dataset.removeLevel),1);renderLevelRows();saveLocal();updateSelectionEditor()}));
}
function addFloorLevel(){
  const last=buildingFLs.at(-1)??0;buildingFLs.push(last+3000);renderLevelRows();saveLocal();updateSelectionEditor();
}
function updateDefaultHeightPreview(){
  defaultFL=Number($("defaultFL").value||700);defaultBaseHeight=Number($("defaultBaseHeight").value||0);defaultFloorCount=Math.max(1,Math.round(Number($("defaultFloorCount").value)||1));
  $("defaultFloorCount").value=defaultFloorCount;const first=Math.max(0,defaultFL-defaultBaseHeight),upperLevel=defaultFL+(defaultFloorCount-1)*1900+900;
  $("defaultActualHeight").textContent="FL "+upperLevel.toLocaleString()+" mm";$("addMode").disabled=first<=0;saveLocal();
}
function applyDefaultLevelToAll(){
  const first=defaultFL-defaultBaseHeight;if(!blocks.length||first<=0)return;
  commit(blocks.map(b=>({...b,firstFloorFL:defaultFL,floorCount:defaultFloorCount,baseHeight:defaultBaseHeight})));updateSelectionEditor();status(blocks.length+"件すべてに作業床設定を反映しました");
}
function handleDefaultLevelInput(){
  updateDefaultHeightPreview();clearTimeout(levelApplyTimer);levelApplyTimer=setTimeout(applyDefaultLevelToAll,250);
}
function applyPanelState(){
  document.querySelector(".workspace").classList.toggle("right-collapsed",panelCollapsed);$("rightPanel").classList.toggle("collapsed",panelCollapsed);
  $("summaryToggle").textContent=panelCollapsed?"‹":"›";$("summaryToggle").setAttribute("aria-expanded",String(!panelCollapsed));
  $("summaryToggle").title=panelCollapsed?"選択・概算数量を開く":"選択・概算数量を閉じる";
}
function download(name,content,type){
  downloadBlob(name,new Blob([content],{type}));
}
function downloadBlob(name,blob){
  const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function applyProjectData(data){
  if(!Array.isArray(data.blocks))throw new Error("配置データがありません");
  history=[...history,structuredClone(blocks)];blocks=data.blocks.map(normalizeBlock);
  if(Number.isFinite(data.mmPerPx))mmPerPx=data.mmPerPx;
  if(Number.isFinite(data.drawingScale)){drawingScale=data.drawingScale;$("drawingScale").value=drawingScale}
  if(Number.isFinite(data.defaultFL)){defaultFL=data.defaultFL;$("defaultFL").value=defaultFL}
  if(Array.isArray(data.buildingFLs)&&data.buildingFLs.length)buildingFLs=data.buildingFLs.map(Number).filter(Number.isFinite);
  if(Number.isFinite(data.defaultBaseHeight)){defaultBaseHeight=data.defaultBaseHeight;$("defaultBaseHeight").value=defaultBaseHeight}
  if(Number.isFinite(data.defaultFloorCount)){defaultFloorCount=Math.max(1,Math.round(data.defaultFloorCount));$("defaultFloorCount").value=defaultFloorCount}
  if(typeof data.panelCollapsed==="boolean")panelCollapsed=data.panelCollapsed;
  selectBlocks([]);applyPanelState();renderLevelRows();updateDefaultHeightPreview();saveLocal();renderBlocks();updateSummary();
}
async function saveProjectZip(){
  try{
    if(!window.JSZip)throw new Error("ZIP機能を読み込めませんでした");status("元図面と配置データをZIPへ保存しています…");
    const fallbackName=drawingKind==="jww"?"drawing.jww":"drawing.pdf",zip=new window.JSZip(),safeSourceName=(pdfSourceName||fallbackName).replace(/[\\/:*?"<>|]/g,"_"),sourcePath=pdfSourceBytes?"drawing/"+safeSourceName:null,drawing=sourcePath?{name:pdfSourceName,path:sourcePath,kind:drawingKind||"pdf",pageNumber}:null;
    const data={version:7,blocks,mmPerPx,drawingScale,defaultFL,buildingFLs,defaultBaseHeight,defaultFloorCount,panelCollapsed,pageNumber,savedAt:new Date().toISOString(),drawing,pdf:drawing?.kind==="pdf"?drawing:null};
    zip.file("project.json",JSON.stringify(data,null,2));if(sourcePath)zip.file(sourcePath,pdfSourceBytes,{binary:true,compression:"STORE"});
    const blob=await zip.generateAsync({type:"blob",compression:"DEFLATE",compressionOptions:{level:6}});downloadBlob("足場拾いプロジェクト.zip",blob);
    status(sourcePath?(drawingKind==="jww"?"JWWを含むプロジェクトZIPを保存しました":"PDFを含むプロジェクトZIPを保存しました"):"配置データをプロジェクトZIPへ保存しました（図面未読込）");
  }catch(error){console.error(error);status("ZIPを保存できませんでした")}
}
async function loadProjectFile(file){
  const isZip=file.name.toLowerCase().endsWith(".zip")||file.type.includes("zip");
  if(!isZip){applyProjectData(JSON.parse(await file.text()));status("従来のJSON配置データを読み込みました");return}
  if(!window.JSZip)throw new Error("ZIP機能を読み込めませんでした");status("プロジェクトZIPを読み込んでいます…");
  const zip=await window.JSZip.loadAsync(file),projectEntry=zip.file("project.json")||Object.values(zip.files).find(entry=>!entry.dir&&entry.name.toLowerCase().endsWith(".json"));
  if(!projectEntry)throw new Error("project.jsonがありません");const data=JSON.parse(await projectEntry.async("text"));applyProjectData(data);
  const drawingMeta=data.drawing||data.pdf,sourceEntry=(drawingMeta?.path&&zip.file(drawingMeta.path))||Object.values(zip.files).find(entry=>!entry.dir&&/\.(pdf|jww)$/i.test(entry.name));
  if(sourceEntry){
    const bytes=await sourceEntry.async("uint8array"),name=drawingMeta?.name||sourceEntry.name.split("/").at(-1)||"drawing.pdf",kind=drawingMeta?.kind||(name.toLowerCase().endsWith(".jww")?"jww":"pdf");await loadDrawingFile(new File([bytes],name,{type:kind==="pdf"?"application/pdf":"application/octet-stream"}));
    if(Number.isFinite(data.mmPerPx))mmPerPx=data.mmPerPx;if(kind==="pdf"){pageNumber=Math.max(1,Math.min(pageCount,Math.round(drawingMeta?.pageNumber||data.pageNumber||1)));if(pageNumber!==1)await renderPdf()}else renderJww();renderBlocks();updateSummary();
  }
  status(sourceEntry?(drawingKind==="jww"?"JWWと足場配置を復元しました":"PDFと足場配置を復元しました"):"足場配置を復元しました（ZIP内に図面はありません）");
}
function removeSelected(){
  if(!selectedIds.size)return;
  const count=selectedIds.size;
  commit(blocks.filter(b=>!selectedIds.has(b.id)));
  selectBlocks([]);
  status(count+"件の足場を削除しました（元に戻すことができます）");
}

$("pdfInput").addEventListener("change",e=>e.target.files[0]&&loadDrawingFile(e.target.files[0]));
$("quantityBody").addEventListener("click",e=>{const button=e.target.closest("[data-quantity-toggle]");if(!button)return;const name=button.dataset.quantityToggle;quantityCollapsed.has(name)?quantityCollapsed.delete(name):quantityCollapsed.add(name);updateSummary()});
document.querySelector(".pdf-drop").addEventListener("dragover",e=>e.preventDefault());
document.querySelector(".pdf-drop").addEventListener("drop",e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f&&(/\.(pdf|jww)$/i.test(f.name)||f.type==="application/pdf"))loadDrawingFile(f)});
$("prevPage").onclick=async()=>{if(pageNumber>1){pageNumber--;fitOnNextRender=true;await renderPdf()}};
$("nextPage").onclick=async()=>{if(pageNumber<pageCount){pageNumber++;fitOnNextRender=true;await renderPdf()}};
$("drawingScale").onchange=e=>{drawingScale=Number(e.target.value);mmPerPx=drawingScale*(25.4/72)/BASE_SCALE;calibrationPoints=[];saveLocal();renderBlocks();renderCalibration();status("図面縮尺を 1/"+drawingScale+" に設定しました")};
$("calibrate").onclick=()=>{calibrationPoints=[];setTool("calibrate");renderCalibration();status("図面上の基準寸法の両端をクリックしてください")};
document.querySelectorAll("[data-span]").forEach(el=>el.onclick=()=>{document.querySelectorAll("[data-span]").forEach(v=>v.classList.remove("active"));el.classList.add("active");span=Number(el.dataset.span);setTool("add")});
$("scaffoldWidth").onchange=e=>width=Number(e.target.value);
$("placeStair").onchange=e=>{placementStair=e.target.checked;if(placementStair){const target=document.querySelector('[data-span="1829"]');target?.click();$("addMode").textContent="＋ 階段付き足場を配置"}else $("addMode").textContent="＋ 図面をクリックして配置"};
$("defaultFL").oninput=handleDefaultLevelInput;$("defaultBaseHeight").oninput=handleDefaultLevelInput;$("defaultFloorCount").oninput=handleDefaultLevelInput;$("addFloorLevel").onclick=addFloorLevel;
$("addMode").onclick=$("placeMode").onclick=()=>setTool("add");$("selectMode").onclick=()=>setTool("select");$("fitView").onclick=fitToView;
$("summaryToggle").onclick=()=>{panelCollapsed=!panelCollapsed;applyPanelState();saveLocal()};
document.querySelectorAll(".section-toggle").forEach(toggle=>toggle.addEventListener("click",()=>setSectionOpen(toggle.closest(".setup-section").id,toggle.getAttribute("aria-expanded")!=="true")));

canvasScroll.addEventListener("wheel",event=>{
  event.preventDefault();wheelAnchor={clientX:event.clientX,clientY:event.clientY};
  pendingWheelZoom=Math.max(.35,Math.min(2.5,(pendingWheelZoom??zoom)+(event.deltaY<0?.12:-.12)));
  clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{const next=pendingWheelZoom,anchor=wheelAnchor;pendingWheelZoom=null;wheelAnchor=null;applyZoom(next,anchor)},45);
},{passive:false});
canvasScroll.addEventListener("pointerdown",event=>{
  if(event.button!==1)return;event.preventDefault();pan={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,left:canvasScroll.scrollLeft,top:canvasScroll.scrollTop};
  canvasScroll.classList.add("is-panning");canvasScroll.setPointerCapture(event.pointerId);
});
canvasScroll.addEventListener("pointermove",event=>{
  if(!pan||event.pointerId!==pan.pointerId)return;event.preventDefault();canvasScroll.scrollLeft=pan.left-(event.clientX-pan.startX);canvasScroll.scrollTop=pan.top-(event.clientY-pan.startY);
});
const stopPan=event=>{if(!pan||event.pointerId!==pan.pointerId)return;pan=null;canvasScroll.classList.remove("is-panning")};
canvasScroll.addEventListener("pointerup",stopPan);canvasScroll.addEventListener("pointercancel",stopPan);canvasScroll.addEventListener("auxclick",event=>{if(event.button===1)event.preventDefault()});

stage.addEventListener("contextmenu",e=>e.preventDefault());
stage.addEventListener("pointerdown",e=>{
  if(e.button===0&&!e.shiftKey&&tool==="add"){
    e.preventDefault();const p=point(e),firstHeight=defaultFL-defaultBaseHeight;
    if(firstHeight<=0){status("1段目作業床高さは設置面高さより大きくしてください");return}
    if(placementStair&&(span!==1829||defaultFloorCount<2)){status("階段は1829スパン・作業床2層以上で配置してください");return}
    series={start:p,current:p,w:span/mmPerPx,d:width/mmPerPx,span,width,firstFloorFL:defaultFL,floorCount:defaultFloorCount,baseHeight:defaultBaseHeight,hasStair:placementStair};
    stage.classList.add("series-placing");stage.setPointerCapture(e.pointerId);renderSeries();return;
  }
  if(e.button!==2&&!(e.button===0&&e.shiftKey))return;e.preventDefault();setTool("select");const p=point(e);range={start:p,current:p};
  stage.classList.add("range-selecting");stage.setPointerCapture(e.pointerId);renderRange();
});
stage.addEventListener("click",e=>{
  if(suppressNextClick){suppressNextClick=false;return}
  const p=point(e);
  if(tool==="calibrate"){
    calibrationPoints=[...calibrationPoints,p].slice(-2);renderCalibration();
    if(calibrationPoints.length===2){
      const px=Math.hypot(calibrationPoints[1].x-calibrationPoints[0].x,calibrationPoints[1].y-calibrationPoints[0].y),known=Number($("knownLength").value);
      if(px>2&&known>0){mmPerPx=known/px;saveLocal();renderBlocks();status("基準寸法 "+known.toLocaleString()+"mm で補正しました");setTool("add")}
    }return;
  }
  if(tool!=="add"){selectBlock(null);return}
  const firstHeight=defaultFL-defaultBaseHeight;if(firstHeight<=0){status("1段目作業床高さは設置面高さより大きくしてください");return}
  if(placementStair&&(span!==1829||defaultFloorCount<2)){status("階段は1829スパン・作業床2層以上で配置してください");return}
  const w=span/mmPerPx,d=width/mmPerPx,raw={id:uid(),x:Math.max(0,p.x-w/2),y:Math.max(0,p.y-d/2),span,width,firstFloorFL:defaultFL,floorCount:defaultFloorCount,baseHeight:defaultBaseHeight,rotation:0,outerProtection:"handrail",innerProtection:"handrail",hasStair:placementStair};
  const result=snapBlock(raw),b=result.block;commit([...blocks,b]);selectBlock(b.id);status(result.snapped?"支柱位置に吸着して配置しました":span+"mmスパンを配置しました");
});
stage.addEventListener("pointermove",e=>{
  const p=point(e);if(series){series.current=p;renderSeries();return}if(resize){resize.current=p;renderResizePreview();return}if(range){range.current=p;renderRange();return}if(!drag)return;
  const dx=p.x-drag.start.x,dy=p.y-drag.start.y;
  if(drag.ids.length===1){
    const id=drag.ids[0],moving=blocks.find(b=>b.id===id),origin=drag.origins.get(id);if(!moving||!origin)return;
    const result=snapBlock({...moving,x:Math.max(0,origin.x+dx),y:Math.max(0,origin.y+dy)},id);
    blocks=blocks.map(b=>b.id===id?result.block:b);if(result.snapped)status("支柱位置に吸着しました");
  }else{
    blocks=blocks.map(b=>{const origin=drag.origins.get(b.id);return origin?{...b,x:Math.max(0,origin.x+dx),y:Math.max(0,origin.y+dy)}:b});
  }
  renderBlocks();updateSummary();
});
stage.addEventListener("pointerup",e=>{
  if(series){
    series.current=point(e);const count=seriesCount(series),direction=series.current.x>=series.start.x?1:-1;
    const raw={id:uid(),x:Math.max(0,series.start.x-series.w/2),y:Math.max(0,series.start.y-series.d/2),span:series.span,width:series.width,firstFloorFL:series.firstFloorFL,floorCount:series.floorCount,baseHeight:series.baseHeight,rotation:0,outerProtection:"handrail",innerProtection:"handrail",hasStair:series.hasStair};
    const first=snapBlock(raw).block,created=[];
    for(let i=0;i<count;i++){
      const candidate={...first,id:i===0?first.id:uid(),x:Math.max(0,first.x+i*direction*series.w)};
      if([...blocks,...created].some(other=>overlapArea(candidate,other)>1))continue;created.push(candidate);
    }
    series=null;suppressNextClick=true;stage.classList.remove("series-placing");selectionLayer.innerHTML="";
    if(created.length){commit([...blocks,...created]);selectBlocks(created.map(b=>b.id));status(created.length+"区画を横方向へ連続配置しました")}else status("重なる位置には配置できません");
  }
  if(resize){
    resize.current=point(e);const count=resizeCount(resize),direction=resize.current.x>=resize.start.x?1:-1,created=[];
    for(let i=1;i<=count;i++){
      const candidate={...resize.origin,id:uid(),x:Math.max(0,resize.origin.x+direction*i*resize.w)};
      if([...blocks,...created].some(other=>overlapArea(candidate,other)>1))continue;created.push(candidate);
    }
    const sourceId=resize.id;resize=null;stage.classList.remove("series-placing");selectionLayer.innerHTML="";
    if(created.length){commit([...blocks,...created]);selectBlocks([sourceId,...created.map(b=>b.id)]);status(created.length+"区画を右下ハンドルから延長しました")}else status("重なる位置には延長できません");
  }
  if(range){
    range.current=point(e);const r=rectangle(range.start,range.current);
    const ids=blocks.filter(b=>{const d=dimensions(b);return b.x+d.w>=r.left&&b.x<=r.right&&b.y+d.h>=r.top&&b.y<=r.bottom}).map(b=>b.id);
    range=null;suppressNextClick=true;stage.classList.remove("range-selecting");renderRange();selectBlocks(ids);status(ids.length?ids.length+"件の足場を範囲選択しました":"範囲内に足場がありません");
  }
  if(drag){drag=null;saveLocal();updateSelectionEditor()}
});
stage.addEventListener("pointercancel",()=>{drag=null;range=null;series=null;resize=null;stage.classList.remove("range-selecting","series-placing");selectionLayer.innerHTML=""});

$("zoomOut").onclick=()=>applyZoom(zoom-.15);$("zoomIn").onclick=()=>applyZoom(zoom+.15);
$("undo").onclick=()=>{const prev=history.at(-1);if(!prev)return;future=[structuredClone(blocks),...future];blocks=prev.map(normalizeBlock);history=history.slice(0,-1);selectBlocks([]);saveLocal();renderBlocks();updateSummary()};
$("redo").onclick=()=>{const next=future[0];if(!next)return;history=[...history,structuredClone(blocks)];blocks=next.map(normalizeBlock);future=future.slice(1);selectBlocks([]);saveLocal();renderBlocks();updateSummary()};
$("selectedFL").onchange=e=>applyElevationChange("firstFloorFL",e.target.value);
$("selectedBaseHeight").onchange=e=>applyElevationChange("baseHeight",e.target.value);
$("selectedFloorCount").onchange=e=>applyElevationChange("floorCount",Math.max(1,Math.round(Number(e.target.value)||1)));
$("selectedKind").onchange=e=>{if(e.target.value==="stair")$("selectedSpan").value="1829"};
$("changeSelected").onclick=()=>{
  if(!selectedIds.size)return;
  const nextSpan=Number($("selectedSpan").value),nextWidth=Number($("selectedWidth").value),asStair=$("selectedKind").value==="stair";
  const selected=selectedBlocks();
  if(asStair&&selected.some(block=>floorCountOf(block)<2)){status("階段付きへの変更は作業床2層以上で行ってください");return}
  commit(blocks.map(block=>selectedIds.has(block.id)?{...block,span:asStair?1829:nextSpan,width:nextWidth,hasStair:asStair}:block));
  updateSelectionEditor();status(selected.length+"件を "+(asStair?"1829 × "+nextWidth+" 階段付き":nextSpan+" × "+nextWidth)+" に変更しました");
};
const openSectionModal=()=>{if(selectedIds.size&&!$("sectionModal").open)$("sectionModal").showModal()};
$("selectionSectionView").onclick=openSectionModal;
$("selectionSectionView").onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openSectionModal()}};
$("closeSectionModal").onclick=()=>$("sectionModal").close();
$("sectionModal").onclick=e=>{if(e.target===$("sectionModal"))$("sectionModal").close()};
$("rotate").onclick=()=>{if(!selectedIds.size)return;commit(blocks.map(b=>selectedIds.has(b.id)?{...b,rotation:b.rotation===0?90:0}:b));updateSelectionEditor()};
$("duplicate").onclick=()=>{const copies=selectedBlocks().map(b=>({...b,id:uid(),x:b.x+18,y:b.y+18}));if(!copies.length)return;commit([...blocks,...copies]);selectBlocks(copies.map(b=>b.id))};
$("remove").onclick=removeSelected;
document.addEventListener("keydown",e=>{
  if(e.key!=="Delete"&&e.key!=="Backspace")return;
  const target=e.target;
  if(target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||target?.isContentEditable)return;
  if(!selectedIds.size)return;
  e.preventDefault();
  removeSelected();
});
$("saveProject").onclick=saveProjectZip;
$("projectInput").onchange=async e=>{const file=e.target.files[0];if(!file)return;try{await loadProjectFile(file)}catch(error){console.error(error);status("プロジェクトデータを読み込めませんでした")}finally{e.target.value=""}};
$("csv").onclick=()=>{const rows=[["部材名","規格・条件","数量","単位"],...quantities().map(r=>r[4]==="group"?[r[0],r[1],"",""]:r.slice(0,4))],csv="\ufeff"+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(",")).join("\r\n");download("足場概算数量.csv",csv,"text/csv;charset=utf-8")};
$("print").onclick=()=>window.print();

try{
  const data=JSON.parse(localStorage.getItem(KEY)||"{}");
  if(Array.isArray(data.blocks))blocks=data.blocks.map(normalizeBlock);if(data.mmPerPx)mmPerPx=data.mmPerPx;
  if(data.drawingScale){drawingScale=data.drawingScale;$("drawingScale").value=drawingScale}
  if(Number.isFinite(data.defaultFL)){defaultFL=data.defaultFL;$("defaultFL").value=defaultFL}
  if(Array.isArray(data.buildingFLs)&&data.buildingFLs.length)buildingFLs=data.buildingFLs.map(Number).filter(Number.isFinite);
  if(Number.isFinite(data.defaultBaseHeight)){defaultBaseHeight=data.defaultBaseHeight;$("defaultBaseHeight").value=defaultBaseHeight}
  if(data.workFloorBasisV2===true&&Number.isFinite(data.defaultFloorCount)){defaultFloorCount=Math.max(1,Math.round(data.defaultFloorCount));$("defaultFloorCount").value=defaultFloorCount}
  if(data.workFloorBasisV2!==true)blocks=blocks.map(b=>normalizeBlock({...b,firstFloorFL:Number(b.baseHeight||0)+700,floorCount:1}));
  if(typeof data.panelCollapsed==="boolean")panelCollapsed=data.panelCollapsed;if(blocks.length)status("前回の配置データを復元しました");
}catch{localStorage.removeItem(KEY)}
renderLevelRows();updateDefaultHeightPreview();applyPanelState();setStageSize();renderBlocks();updateSummary();updateSelectionEditor();status($("status").textContent);
