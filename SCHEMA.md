[
  {
    "name": "AX_search_product",
    "description": "Search Amazon products by query. Use cursor from a previous result to fetch the next page.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "cursor": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_product",
    "description": "View Amazon product details, variations, selected options, and purchasable form controls by product id.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_update_product",
    "description": "Update Amazon product variation selections and form values before purchase.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_add_to_cart",
    "description": "Add an Amazon product to the cart, optionally applying quantity, variations, and form values first.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_cart",
    "description": "Navigate to the Amazon cart and return the current cart items.",
    "parameters": {
      "additionalProperties": false,
      "properties": {},
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_update_cart",
    "description": "Update the quantity of an Amazon cart item by product id. Set quantity to 0 to delete the item.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "product_id",
        "quantity"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_checkout",
    "description": "Navigate to the Amazon cart and proceed to checkout. When the checkout page is reached, returns its data (delivering_to, shipping_address, payment_method, order_summary, place_order_available). Returns status login_required when sign-in is needed; does not place an order.",
    "parameters": {
      "additionalProperties": false,
      "properties": {},
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_resolve_zip",
    "description": "Resolve a US ZIP code from an address string for Thumbtack searches.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "address": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "address"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_search_service",
    "description": "Search Thumbtack services and local pros by query and ZIP code or address.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "zip_code": {
          "minLength": 5,
          "type": "string"
        },
        "address": {
          "minLength": 1,
          "type": "string"
        },
        "cursor": {
          "minLength": 1,
          "type": "string"
        },
        "filters": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "query"
      ],
      "anyOf": [
        {
          "required": [
            "zip_code"
          ]
        },
        {
          "required": [
            "address"
          ]
        }
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_service",
    "description": "View a Thumbtack pro profile from a search result URL, including ratings, overview, services, photos, reviews, credentials, FAQs, and available actions.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "service_id": {
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_answer_quote",
    "description": "Answer the active Thumbtack quote step or fill legacy quote fields. It may click Next/Continue or optional-step Skip, but it refuses send/submit buttons.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "answers": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        },
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "selection": {
          "minLength": 1,
          "type": "string"
        },
        "selections": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "text": {
          "minLength": 1,
          "type": "string"
        },
        "advance": {
          "type": "boolean"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_open_quote",
    "description": "Open or inspect a Thumbtack quote flow from a pro profile URL. Optional step values may advance through Next/Continue or optional-step Skip; submit/send is never clicked.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "service_id": {
          "minLength": 1,
          "type": "string"
        },
        "url": {
          "minLength": 1,
          "type": "string"
        },
        "answers": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        },
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "selection": {
          "minLength": 1,
          "type": "string"
        },
        "selections": {
          "items": {
            "minLength": 1,
            "type": "string"
          },
          "type": "array"
        },
        "text": {
          "minLength": 1,
          "type": "string"
        },
        "advance": {
          "type": "boolean"
        },
        "submit": {
          "type": "boolean"
        }
      },
      "required": [
        "url"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_update_search",
    "description": "Change a search filter (service option) on the Thumbtack search-results screen by its visible choice text, then re-read the filters and matching pros.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "value": {
          "minLength": 1,
          "type": "string"
        },
        "option": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "type": "object"
    }
  }
]
