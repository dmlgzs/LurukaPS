-- Hide existing watermark nodes without adding any launcher notice or text.
local ok, result = pcall(function()
  local wm = require("ui.manager.waterMark.waterMarkManager")
  if wm._lurukaps_watermark_disabled then return true end
  local function hide(self)
    if L_CommonUtil.isValid(self.markImage) then self.markImage.gameObject:ActiveTrans(false) end
    if L_CommonUtil.isValid(self.testWaterMarkNode) then self.testWaterMarkNode.gameObject:ActiveTrans(false) end
    local root = L_UI:getRoot()
    if L_CommonUtil.isValid(root) then
      local old = root:Find("[WaterMark]")
      if L_CommonUtil.isValid(old) then old.gameObject:SetActive(false) end
    end
  end
  wm.refreshMarkNode = hide
  wm.refreshTestWaterMark = hide
  wm.setActiveVisiableWaterMark = hide
  wm._lurukaps_watermark_disabled = true
  print("[LurukaPS-client] watermark display disabled")
  return true
end)
if not ok then print("[LurukaPS-client] watermark policy failed: " .. tostring(result)) end
return ok and result
