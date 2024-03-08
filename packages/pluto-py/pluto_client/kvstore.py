from pydantic import BaseModel
from typing import Optional
from pluto_base.resource import (
    IResource,
    IResourceCapturedProps,
    IResourceClientApi,
    IResourceInfraApi,
)
from pluto_base.platform import PlatformType
from pluto_base import utils
from .clients import aws


class KVStoreOptions(BaseModel):
    pass


class IKVStoreClientApi(IResourceClientApi):
    def get(self, key: str) -> str:
        raise NotImplementedError

    def set(self, key: str, val: str):
        raise NotImplementedError


class IKVStoreInfraApi(IResourceInfraApi):
    pass


class IKVStoreCapturedProps(IResourceCapturedProps):
    pass


class IKVStoreClient(IKVStoreClientApi, IKVStoreCapturedProps):
    pass


class IKVStoreInfra(IKVStoreInfraApi, IKVStoreCapturedProps):
    pass


class KVStore(IResource, IKVStoreClient, IKVStoreInfra):
    fqn = "@plutolang/pluto.KVStore"

    def __init__(self, name: str, opts: Optional[KVStoreOptions] = None):
        raise NotImplementedError(
            "cannot instantiate this class, instead of its subclass depending on the target runtime."
        )

    @staticmethod
    def build_client(
        name: str, opts: Optional[KVStoreOptions] = None
    ) -> IKVStoreClient:
        platform_type = utils.current_platform_type()
        if platform_type == PlatformType.AWS:
            return aws.DynamoKVStore(name, opts)
        else:
            raise ValueError(f"not support this runtime '{platform_type}'")