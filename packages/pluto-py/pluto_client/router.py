from pydantic import BaseModel
from typing import Callable, Dict, Optional
from pluto_base.platform import PlatformType
from pluto_base import utils, resource
from .clients import shared


class HttpRequest(BaseModel):
    path: str
    method: str
    headers: Dict[str, str]
    query: Dict[str, str | list[str]]
    body: Optional[str]


class HttpResponse(BaseModel):
    status_code: int
    body: str


RequestHandler = Callable[[HttpRequest], HttpResponse]


class RouterOptions(BaseModel):
    pass


class IRouterClientApi(resource.IResourceClientApi):
    pass


class IRouterInfraApi(resource.IResourceInfraApi):
    def get(self, path: str, fn: RequestHandler):
        raise NotImplementedError

    def post(self, path: str, fn: RequestHandler):
        raise NotImplementedError

    def put(self, path: str, fn: RequestHandler):
        raise NotImplementedError

    def delete(self, path: str, fn: RequestHandler):
        raise NotImplementedError


class IRouterCapturedProps(resource.IResourceCapturedProps):
    def url(self) -> str:
        raise NotImplementedError


class IRouterClient(IRouterClientApi, IRouterCapturedProps):
    pass


class IRouterInfra(IRouterInfraApi, IRouterCapturedProps):
    pass


class Router(resource.IResource, IRouterClient, IRouterInfra):
    fqn = "@plutolang/pluto.Router"

    def __init__(self, name: str, opts: Optional[RouterOptions] = None):
        raise NotImplementedError(
            "Cannot instantiate this class, instead of its subclass depending on the target runtime."
        )

    @staticmethod
    def build_client(name: str, opts: Optional[RouterOptions] = None) -> IRouterClient:
        platform_type = utils.current_platform_type()
        if platform_type in [PlatformType.AWS, PlatformType.K8s, PlatformType.AliCloud]:
            return shared.RouterClient(name, opts)
        else:
            raise ValueError(f"not support this runtime '{platform_type}'")