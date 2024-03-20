import os
import json
import base64


def is_http_payload(payload):
    return (
        payload is not None
        and isinstance(payload, dict)
        and "headers" in payload
        and "queryStringParameters" in payload
        and "rawPath" in payload
    )


def handler(payload, context):
    account_id = context.invoked_function_arn.split(":")[4]
    os.environ["AWS_ACCOUNT_ID"] = account_id
    try:
        print("Payload:", payload)
        if is_http_payload(payload):
            if payload["isBase64Encoded"]:
                body = base64.b64decode(payload["body"]).decode("utf-8")
            else:
                body = payload["body"]
            payload = json.loads(body)

        if not isinstance(payload, list):
            return {
                "code": 400,
                "body": "Payload should be an array.",
            }

        try:
            user_handler = globals()["__handler_"]
            result = user_handler(*payload)
            response = {
                "code": 200,
                "body": result,
            }
        except Exception as e:
            print("Function execution failed:", str(e))
            response = {
                "code": 400,
                "body": "Function execution failed: " + str(e),
            }
        return response

    except Exception as e:
        print("Something wrong:", str(e))
        return {
            "code": 500,
            "body": "Something wrong. Please contact the administrator.",
        }