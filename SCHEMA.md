[
  {
    "name": "browse_service_candidates",
    "description": "Rank, filter, window, and select searched Thumbtack pros deterministically from the site data.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "candidates"
      ],
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "candidates": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "refine_request": {
          "type": [
            "string",
            "null"
          ]
        },
        "page_command": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "next",
            "prev",
            "first",
            "last",
            null
          ]
        },
        "page_number": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        },
        "choice_numbers": {
          "type": [
            "string",
            "null"
          ]
        },
        "view_page": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "cancel_quote_request",
    "description": "Record that the user declined or cancelled the quote request. Nothing is searched, opened, or sent.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "reason": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "capture_memory_clause",
    "description": "Read the user's own message and, only when it carries an explicit remember/save clause, report the values beside that clause. Deterministic; no model call, no browser op.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "userMessages": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "cart_open_lines",
    "description": "Read the cart of the store the user is on and carry its lines to the turn that shows them. Touches nothing.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "site": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "cart_present_lines",
    "description": "Render the cart's lines as one numbered window, pause on it, and read the user's answer deterministically.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "cart_state": {
          "type": [
            "string",
            "null"
          ]
        },
        "choice_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "cart_remove_line",
    "description": "Remove ONE approved line from the cart. Never adds, never enters checkout, never places an order.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "product_id"
      ],
      "properties": {
        "site": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_id": {
          "type": "string"
        },
        "cart_approval": {
          "type": "string",
          "enum": [
            "user_confirmed_removal"
          ]
        }
      }
    }
  },
  {
    "name": "checkout",
    "description": "Navigate to the cart and open the checkout REVIEW page so the user can read the order total, address and payment method. Never places an order.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "checkout_decision",
    "description": "Record the user's checkout approval decision after items are in the cart — proceed to the checkout page (no order placed), finish without checkout, or keep asking.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "checkout",
            "done",
            "cancel"
          ]
        },
        "question": {
          "type": "string"
        },
        "checkout_stage": {
          "type": [
            "string",
            "null"
          ]
        },
        "message": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "checkout_entry",
    "description": "Route a fresh checkout entry into the site handoff without a remote round trip.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "choose_delete_keys",
    "description": "Ask for or resolve one or more exact memory keys to delete.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "next",
        "question",
        "delete_keys",
        "confirmed"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "delete",
            "cancelled",
            "error"
          ]
        },
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "delete_keys": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "confirmed": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "choose_product_identity",
    "description": "Ask again, cancel, or record an exact user-supplied manufacturer model.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "model",
            "cancel"
          ]
        },
        "question": {
          "type": "string"
        },
        "product_choice_stage": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_kind": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "standardized_model",
            "spec_equivalent",
            "unique_listing",
            null
          ]
        },
        "identity_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_category": {
          "type": [
            "string",
            "null"
          ]
        },
        "canonical_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "collect_quote_contact",
    "description": "Extract every supplied first name, last name, email, and phone from the complete latest user message, then ask for all still-missing contacts in the user's language. For Korean input ask in Korean, for example \"이름, 성, 이메일, 전화번호를 알려주세요.\"",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "question",
        "submit_phone",
        "submit_email",
        "submit_first_name",
        "submit_last_name"
      ],
      "properties": {
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_phone": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "submit_email": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "submit_first_name": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "submit_last_name": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "collect_quote_location",
    "description": "Copy an explicit five-digit token from the complete latest user message as the ZIP; otherwise translate its US city/address to English. \"샌프란시스코에서\" must produce address \"San Francisco, CA\", not a question.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "question",
        "address",
        "zip_code"
      ],
      "properties": {
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "address": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "zip_code": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^[0-9]{5}$"
        }
      }
    }
  },
  {
    "name": "collect_quote_location_retry",
    "description": "Ask for and collect a replacement location after ZIP resolution fails.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "question",
        "address",
        "zip_code",
        "zip_status"
      ],
      "properties": {
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "address": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "zip_code": {
          "type": [
            "string",
            "null"
          ],
          "pattern": "^[0-9]{5}$"
        },
        "zip_status": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "collect_quote_service",
    "description": "Scan the complete latest user message for a named service and any work scope or timing before asking. For example, \"핸디맨으로 작은 집 청소, 48시간 내 일회성\" is a complete handyman service stage.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "question",
        "service_query",
        "user_requirements"
      ],
      "properties": {
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "service_query": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "user_requirements": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "collect_ready_total_cost_request",
    "description": "Capture product identity and constraints for a deterministically complete multi-store scope.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next",
        "query",
        "product_category",
        "quantity",
        "stores",
        "query_variants",
        "brand_aliases"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "done",
            "cancel"
          ]
        },
        "query": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "requested_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "requested_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "query_variants": {
          "type": "string"
        },
        "brand_aliases": {
          "type": "string"
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "uniqueItems": true,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "collect_shopping",
    "description": "Fill the shopping list (shop_plan — an array of { query, quantity }) and choose the next step (ask the user to clarify, or finish).",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "done",
            "cancel"
          ]
        },
        "question": {
          "type": "string"
        },
        "shop_plan": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "query": {
                "type": "string"
              },
              "quantity": {
                "type": [
                  "integer",
                  "number"
                ]
              }
            }
          }
        },
        "site": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "amazon",
            "ebay",
            "walmart",
            "aliexpress",
            "etsy",
            "coupang",
            "11st",
            "gmarket",
            "ssg",
            "naver-shopping",
            null
          ]
        },
        "message": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "collect_total_cost_request",
    "description": "Capture one product category, optional exact brand/model and constraints, quantity, and two to ten supported commerce sites, or ask for clarification.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "done",
            "cancel"
          ]
        },
        "question": {
          "type": "string"
        },
        "query": {
          "type": "string"
        },
        "product_category": {
          "type": "string"
        },
        "requested_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "requested_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "query_variants": {
          "type": [
            "string",
            "null"
          ]
        },
        "brand_aliases": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "uniqueItems": true,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "community_classify",
    "description": "Decide, without a model, whether the user named a community command this page offers. Names only; the values come next.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "community_confirm",
    "description": "Render the confirm button for a community command the model proposed, plus the sentence beside it naming the script, the publisher, the effect and the values. Renders only; the click is the user's and the broker re-checks it.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "script_id",
        "version",
        "command",
        "effect"
      ],
      "properties": {
        "script_id": {
          "type": "string"
        },
        "script_name": {
          "type": "string"
        },
        "publisher_id": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "command": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "effect": {
          "type": "string"
        },
        "arguments_json": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "community_propose",
    "description": "Propose one community command for the user to run, with the values it should carry. Renders nothing and runs nothing — the user presses a button, and the extension checks everything again before it does.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "command"
      ],
      "properties": {
        "command": {
          "type": "string"
        },
        "arguments_json": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "confirm_quote_decision",
    "description": "Classify the current quote approval reply without model judgement.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "quote_confirm_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "decide",
    "description": "Select configured intent flows and initial runtime state for the config-runtime planner.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "action",
        "intents"
      ],
      "properties": {
        "set": {
          "type": "boolean"
        },
        "action": {
          "type": "string",
          "enum": [
            "continue_current",
            "replace_current",
            "clarify",
            "out_of_scope"
          ]
        },
        "intents": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "intent",
              "segments",
              "state"
            ],
            "properties": {
              "intent": {
                "type": "string",
                "enum": [
                  "request_service_quote",
                  "shopping_single_site",
                  "shopping_multi_store_total_cost",
                  "end_conversation",
                  "checkout",
                  "memory"
                ]
              },
              "segments": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "type": "string"
                }
              },
              "state": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "requestText"
                ],
                "properties": {
                  "requestText": {
                    "type": "string",
                    "minLength": 1
                  },
                  "followup": {
                    "type": "object",
                    "additionalProperties": true,
                    "required": [
                      "type",
                      "question"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "info_question"
                        ]
                      },
                      "question": {
                        "type": "string",
                        "minLength": 1
                      },
                      "topic": {
                        "type": "string",
                        "minLength": 1
                      },
                      "scope": {
                        "type": "string",
                        "enum": [
                          "active_state"
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "question": {
          "type": "string"
        },
        "conversationSummary": {
          "type": "string"
        },
        "latestMessageInterpretation": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "delete_memory",
    "description": "Delete one or more exact GLOBAL memory keys selected by the user.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "delete_keys",
        "confirmed"
      ],
      "properties": {
        "delete_keys": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "confirmed": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "detect_cancellation",
    "description": "Decide whether the latest message is a standalone refusal rather than a request.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "enter_checkout_site",
    "description": "Get the browser onto the store whose cart is being reviewed — the one already open, since that is where the items were added — and confirm it arrived.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "site": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "enter_shopping_site",
    "description": "Resolve the store this turn shops on — named, else already open, else default — get the browser onto it, and confirm it arrived.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "site": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "find_delete_candidates",
    "description": "Find exact memory key candidates for an explicit category deletion request.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "regex"
      ],
      "properties": {
        "regex": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      }
    }
  },
  {
    "name": "finish_quote_request",
    "description": "Finish collection after every required quote-request field is present.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    }
  },
  {
    "name": "followup_decision",
    "description": "After reporting quote outcomes, choose whether to request more quotes from the current results, start a new service request, or finish — carrying any state reset needed.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "more",
            "new",
            "done"
          ]
        },
        "question": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "refine_stage": {
          "type": [
            "string",
            "null"
          ]
        },
        "refine_selected": {
          "type": [
            "array",
            "null"
          ]
        },
        "service_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "user_requirements": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_results": {
          "type": [
            "string",
            "null"
          ]
        },
        "followup_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "get_memory",
    "description": "Read one exact saved memory key.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "key"
      ],
      "properties": {
        "key": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "list_memory",
    "description": "List all saved memory keys.",
    "parameters": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "next_product",
    "description": "Record the item just processed into shop_results and pick the next item from shop_plan (sets query/quantity, advances shop_index). No LLM, no navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "shop_plan": {
          "type": [
            "array",
            "null"
          ]
        },
        "shop_index": {
          "type": [
            "integer",
            "null"
          ]
        },
        "shop_results": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "add_status": {
          "type": [
            "string",
            "null"
          ]
        },
        "add_error": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "open_quote",
    "description": "Open the picked pro's quote request and answer every step it can answer, stopping at the final Submit. Never submits or sends.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "quote_url": {
          "type": "string"
        },
        "quote_target_service_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "user_requirements": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_email": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_first_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_last_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_phone": {
          "type": [
            "string",
            "null"
          ]
        },
        "zip_code": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "pick_product",
    "description": "Pick the first usable search candidate to add to the cart. No LLM, no navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "candidates": {
          "type": [
            "array",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "pick_quote",
    "description": "Deterministically pick the next candidate pro to open and advance quote_index. No LLM, no navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "candidates": {
          "type": "array"
        },
        "quote_index": {
          "type": [
            "integer",
            "null"
          ]
        },
        "quote_results": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_error": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_reached_submit": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "quote_answer_status": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_status": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_advance_reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_message": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_last_step": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_answered": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_submit_status": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_submit_message": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_submit_error": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "plan_memory",
    "description": "Plan one explicit memory operation and project its exact arguments into flow state.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "next",
        "operation"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "list",
            "get",
            "search",
            "find_delete",
            "delete",
            "set",
            "error"
          ]
        },
        "operation": {
          "type": "string",
          "enum": [
            "list",
            "get",
            "search",
            "delete",
            "set",
            "delete_candidates"
          ]
        },
        "key": {
          "type": "string",
          "minLength": 1
        },
        "regex": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "delete_keys": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "confirmed": {
          "type": "boolean"
        },
        "memory_entries": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "value"
            ],
            "properties": {
              "key": {
                "type": "string",
                "minLength": 1
              },
              "value": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "playground_amazon_entry",
    "description": "Route a fresh Amazon-fixture entry into its first real step without a remote round trip.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "playground_checkpoint_entry",
    "description": "Route a fresh checkpoint-diagnostic entry into its first real step without a remote round trip.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "playground_collect_multi_site_request",
    "description": "Capture one product search query and two to ten explicitly selected supported commerce sites, or ask for missing scope.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "done"
          ]
        },
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "stores": {
          "type": [
            "array",
            "null"
          ],
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "playground_durable_checkpoint",
    "description": "Run the playground-only durable checkpoint diagnostic. It has no browser side effect and reports whether the host operation grant is available.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "label"
      ],
      "properties": {
        "label": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "playground_query_from_request",
    "description": "Convert a non-empty shopping request into the Amazon search query without a model call.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestText"
      ],
      "properties": {
        "requestText": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "playground_search_amazon_fixture",
    "description": "Search one Playground commerce site over RPC. Accepts a flat query or the fan-out worker envelope. Never changes a cart, checkout, or order.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "site": {
          "type": [
            "string",
            "null"
          ]
        },
        "item": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "index": {
          "type": [
            "number",
            "null"
          ]
        },
        "key": {
          "type": [
            "string",
            "null"
          ]
        },
        "context": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "playground_search_shopping",
    "description": "Search one Playground commerce site over RPC. Accepts a flat query or the fan-out worker envelope. Never changes a cart, checkout, or order.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "site": {
          "type": [
            "string",
            "null"
          ]
        },
        "item": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "index": {
          "type": [
            "number",
            "null"
          ]
        },
        "key": {
          "type": [
            "string",
            "null"
          ]
        },
        "context": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "playground_search_worker",
    "description": "Search one Playground commerce site over RPC. Accepts a flat query or the fan-out worker envelope. Never changes a cart, checkout, or order.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "site": {
          "type": [
            "string",
            "null"
          ]
        },
        "item": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "index": {
          "type": [
            "number",
            "null"
          ]
        },
        "key": {
          "type": [
            "string",
            "null"
          ]
        },
        "context": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "prepare_memory",
    "description": "Convert validated key/value entries into one bulk memory map.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "memory_entries"
      ],
      "properties": {
        "memory_entries": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "key",
              "value"
            ],
            "properties": {
              "key": {
                "type": "string",
                "minLength": 1
              },
              "value": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "prepare_refined_results_table",
    "description": "Convert the refined Thumbtack shortlist into deterministic built-in table-widget data.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "refine_selected"
      ],
      "properties": {
        "refine_selected": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "prepare_service_results_table",
    "description": "Convert searched Thumbtack candidates into deterministic built-in table-widget data.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "service_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "candidates": {
          "type": [
            "array",
            "null"
          ]
        },
        "total_count": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "present_memory_result",
    "description": "Render one memory result as localized consumer text without exposing the wire envelope.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "memory_result": {
          "type": [
            "object",
            "boolean",
            "null"
          ],
          "additionalProperties": true
        },
        "operation": {
          "type": [
            "string",
            "null"
          ]
        },
        "confirmed": {
          "type": [
            "boolean",
            "null"
          ]
        },
        "key": {
          "type": [
            "string",
            "null"
          ]
        },
        "regex": {
          "type": [
            "string",
            "null"
          ]
        },
        "memory": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": {
            "type": "string"
          }
        },
        "delete_keys": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "present_product_options",
    "description": "Present safe discovery choices and classify a current number without model judgement.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "product_option_summaries": {
          "type": [
            "string",
            "null"
          ]
        },
        "unresolved_product_names": {
          "type": [
            "string",
            "null"
          ]
        },
        "options_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_choice_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "present_quote_collection",
    "description": "Present one quote-collection question and pause until the user answers it.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "collect_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "present_refined_results",
    "description": "Present the rendered refined-shortlist widget and ask once for explicit quote approval.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "refined_results_widget": {
          "type": [
            "string",
            "null"
          ]
        },
        "quote_confirm_stage": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "present_service_results",
    "description": "Present the rendered results widget and ask once for the user's refinement criterion.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "question": {
          "type": [
            "string",
            "null"
          ]
        },
        "service_results_widget": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "present_store_offers",
    "description": "Retrieve the exact current comparison and force a separate approval turn before selection.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [],
      "properties": {
        "requestText": {
          "type": [
            "string",
            "null"
          ]
        },
        "userMessages": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "string"
          }
        },
        "choice_stage": {
          "type": [
            "string",
            "null"
          ]
        },
        "comparison_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "view_page": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        },
        "comparison_state": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "recall_saved_contact",
    "description": "Read the saved contact fields from the on-device memory store and publish them as one line for the collect gate. One round trip; nothing is written.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "userMessages": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "refine_products",
    "description": "Refine the searched products for the current item — ask the user which product / how to narrow, or (after they answer) record the chosen product to add, or skip. The LLM ranks/filters the candidates; this tool captures the decision.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "next"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "ask",
            "pick",
            "skip",
            "cancel"
          ]
        },
        "question": {
          "type": "string"
        },
        "shop_refine_stage": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "cart_approval": {
          "type": "string",
          "enum": [
            "user_picked_searched_product"
          ]
        },
        "message": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "render_refined_results",
    "description": "Render the refined shortlist with the built-in table widget.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "refined_results_table"
      ],
      "properties": {
        "refined_results_table": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "render_service_results",
    "description": "Render the prepared service-results data with the built-in table widget.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "service_results_table"
      ],
      "properties": {
        "service_results_table": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "resolve_zip",
    "description": "Resolve a US ZIP code from an address string.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "address"
      ],
      "properties": {
        "address": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "rpc_navigate_probe",
    "description": "Navigate and time each stage, to separate a slow script from a slow channel.",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "rpc_read_page",
    "description": "Read the current page heading and location over the RPC channel.",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "run_checkout",
    "description": "Open the checkout REVIEW page for the standalone checkout flow so the user can read the order total, address and payment method. Never places an order.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "screen_store_offers",
    "description": "Keep the numbered listings that are the requested product itself and drop accessories, parts, bundles, and other models.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "next",
        "keep"
      ],
      "properties": {
        "next": {
          "type": "string",
          "enum": [
            "done"
          ]
        },
        "keep": {
          "type": "string"
        },
        "note": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "search_memory",
    "description": "Search saved memory with one case-insensitive regex and return bounded Markdown.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "regex"
      ],
      "properties": {
        "regex": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      }
    }
  },
  {
    "name": "search_service",
    "description": "Search Thumbtack for local pros matching the service query in the resolved ZIP.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "service_query",
        "zip_code"
      ],
      "properties": {
        "service_query": {
          "type": "string"
        },
        "zip_code": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "select_pros",
    "description": "Replace the candidate list with the user-approved shortlist (refine_selected) and reset the quote loop index. No LLM, no navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "refine_selected": {
          "type": [
            "array",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "set_memory",
    "description": "Set final memory values in one call. Non-empty Markdown saves; an empty string deletes.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "memory",
        "confirmed"
      ],
      "properties": {
        "confirmed": {
          "type": "boolean"
        },
        "memory": {
          "type": "object",
          "minProperties": 1,
          "description": "Memory key to complete Markdown. A non-empty value saves; an empty value deletes.",
          "additionalProperties": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "shopping_add_selected_store_offer",
    "description": "Revalidate product identity and price, then add only the explicitly selected current offer. Never checks out or orders.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "site",
        "product_id",
        "identity_id",
        "comparison_id",
        "identity_approval",
        "comparison_approval",
        "cart_approval"
      ],
      "properties": {
        "site": {
          "type": "string",
          "enum": [
            "amazon",
            "walmart",
            "ebay",
            "aliexpress",
            "etsy",
            "coupang",
            "naver-shopping",
            "gmarket",
            "11st",
            "ssg"
          ]
        },
        "product_id": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "expected_unit_price": {
          "type": [
            "number",
            "null"
          ]
        },
        "expected_currency": {
          "type": [
            "string",
            "null"
          ]
        },
        "expected_identity_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_approval": {
          "type": "string",
          "enum": [
            "locked_product_identity"
          ]
        },
        "comparison_approval": {
          "type": "string",
          "enum": [
            "current_comparison"
          ]
        },
        "cart_approval": {
          "type": "string",
          "enum": [
            "user_selected_compared_offer"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_add_to_cart",
    "description": "Add the picked product to the cart with the requested quantity. Navigates to the product page, revalidates the price, clicks Add to Cart, declines the optional protection plan, and reads the confirmation. Never places an order.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "product_id"
      ],
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "type": [
            "integer",
            "number",
            "string"
          ]
        },
        "cart_approval": {
          "type": "string",
          "enum": [
            "user_picked_searched_product"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_apply_offer_screening",
    "description": "Keep only the judged-relevant listings, apply the per-store comparison cap, and report how many rows were removed.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "screening_ids": {
          "type": [
            "string",
            "null"
          ]
        },
        "screening_keep": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_build_offer_screening",
    "description": "Number every live listing across the searched stores into one bounded, id-backed list for a relevance judgement.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "identity_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_category": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_build_product_options",
    "description": "Group live discovery evidence into versioned manufacturer-model choices.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "discovery_results",
        "discovery_query",
        "product_category"
      ],
      "properties": {
        "discovery_results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "discovery_query": {
          "type": "string",
          "minLength": 1
        },
        "product_category": {
          "type": "string",
          "minLength": 1
        },
        "requested_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "shopping_collect_store_page",
    "description": "Merge one read result page into this store's accumulated candidates and decide whether another page is worth a navigation.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "item",
        "context",
        "store_result",
        "page"
      ],
      "properties": {
        "item": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "site"
          ],
          "properties": {
            "site": {
              "type": "string",
              "enum": [
                "amazon",
                "walmart",
                "ebay",
                "aliexpress",
                "etsy",
                "coupang",
                "naver-shopping",
                "gmarket",
                "11st",
                "ssg"
              ]
            }
          }
        },
        "context": {
          "type": "object",
          "additionalProperties": true,
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string"
            },
            "quantity": {
              "type": [
                "integer",
                "number"
              ]
            }
          }
        },
        "store_result": {
          "type": "object",
          "additionalProperties": true
        },
        "collected": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "page": {
          "type": [
            "integer",
            "number"
          ]
        },
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "tried_queries": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_complete_store_results",
    "description": "Add an explicit unsearched failure for any selected store missing from the fan-out.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "stores"
      ],
      "properties": {
        "stores": {
          "type": "array",
          "minItems": 2,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string"
              }
            }
          }
        },
        "store_results": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "shopping_discover_products",
    "description": "Search at most three deterministic frontier stores for live product-model evidence.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "discovery_sites",
        "query"
      ],
      "properties": {
        "discovery_sites": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        },
        "query": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "discovery_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_category": {
          "type": [
            "string",
            "null"
          ]
        },
        "requested_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "query_variants": {
          "type": [
            "string",
            "null"
          ]
        },
        "brand_aliases": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "shopping_lock_product_identity",
    "description": "Lock one exact manufacturer model or grounded identity into a stable comparison snapshot.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "identity_kind",
        "identity_model",
        "product_category"
      ],
      "properties": {
        "identity_kind": {
          "type": "string",
          "enum": [
            "standardized_model",
            "spec_equivalent",
            "unique_listing"
          ]
        },
        "identity_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_model": {
          "type": "string",
          "minLength": 1
        },
        "product_category": {
          "type": "string",
          "minLength": 1
        },
        "canonical_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "identity_source_refs": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "shopping_normalize_store_result",
    "description": "Apply common relevance, provenance, FX, and landed-cost normalization to one ready site adapter result.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "item",
        "context",
        "store_result"
      ],
      "properties": {
        "item": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "site"
          ],
          "properties": {
            "site": {
              "type": "string",
              "enum": [
                "amazon",
                "walmart",
                "ebay",
                "aliexpress",
                "etsy",
                "coupang",
                "naver-shopping",
                "gmarket",
                "11st",
                "ssg"
              ]
            }
          }
        },
        "context": {
          "type": "object",
          "additionalProperties": true,
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string"
            },
            "quantity": {
              "type": [
                "integer",
                "number"
              ]
            }
          }
        },
        "store_result": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "shopping_prefill_total_cost_request",
    "description": "Resolve an explicitly named multi-store scope deterministically before request normalization.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestText"
      ],
      "properties": {
        "requestText": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "shopping_prepare_product_identity",
    "description": "Classify product scope and deterministically select at most three stores for grounded model discovery.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "product_category",
        "stores"
      ],
      "properties": {
        "product_category": {
          "type": "string",
          "minLength": 1
        },
        "requested_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "requested_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        }
      }
    }
  },
  {
    "name": "shopping_rank_store_offers",
    "description": "Rank only identity-verified candidates while preserving failures and cost coverage.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "verified_offers",
        "identity_id"
      ],
      "properties": {
        "verified_offers": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "failures": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "screened_out": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_refine_store_offers",
    "description": "Move the comparison window, or filter and sort the listing, from the user's own words.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "comparison_id"
      ],
      "properties": {
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "comparison_state": {
          "type": [
            "string",
            "null"
          ]
        },
        "failures": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "identity_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "view_page": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        },
        "view_sort": {
          "type": [
            "string",
            "null"
          ]
        },
        "page_command": {
          "type": [
            "string",
            "null"
          ],
          "enum": [
            "next",
            "prev",
            "first",
            "last",
            null
          ]
        },
        "page_number": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        },
        "refine_request": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_resolve_product_option",
    "description": "Resolve one current discovery option and create a locked identity only from its grounded evidence.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "product_options",
        "options_version",
        "choice_options_version"
      ],
      "properties": {
        "product_options": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "options_version": {
          "type": "string",
          "minLength": 1
        },
        "product_choice_index": {
          "type": [
            "integer",
            "number",
            "null"
          ]
        },
        "product_choice_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "choice_options_version": {
          "type": [
            "string",
            "null"
          ]
        },
        "hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        },
        "soft_preferences": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "shopping_resolve_store_offer",
    "description": "Validate a ranked offer and current comparison snapshot, then emit scoped mutation approvals.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "choice_index",
        "choice_comparison_id"
      ],
      "properties": {
        "choice_index": {
          "type": [
            "integer",
            "number"
          ]
        },
        "choice_comparison_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "comparison_id": {
          "type": "string",
          "minLength": 1
        },
        "comparison_state": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "choice_stage": {
          "type": "string",
          "enum": [
            "asked"
          ]
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_screen_site_candidates",
    "description": "Keep the searched rows that carry every word of the request, for the single-site list.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "query": {
          "type": [
            "string",
            "null"
          ]
        },
        "candidates": {
          "type": [
            "array",
            "null"
          ],
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "shopping_search_one_store",
    "description": "Search one mapped store with a runtime-side script that drives the page over RPC.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "item",
        "index",
        "key",
        "context"
      ],
      "properties": {
        "item": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "site"
          ],
          "properties": {
            "site": {
              "type": "string",
              "enum": [
                "amazon",
                "walmart",
                "ebay",
                "aliexpress",
                "etsy",
                "coupang",
                "naver-shopping",
                "gmarket",
                "11st",
                "ssg"
              ]
            }
          }
        },
        "index": {
          "type": "number"
        },
        "key": {
          "type": "string"
        },
        "context": {
          "type": "object",
          "additionalProperties": true,
          "required": [
            "query"
          ],
          "properties": {
            "query": {
              "type": "string"
            },
            "quantity": {
              "type": [
                "integer",
                "number"
              ]
            }
          }
        },
        "page": {
          "type": [
            "integer",
            "number"
          ]
        },
        "query": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "shopping_search_product",
    "description": "Search the shopping site for the current item's query; returns candidate products.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "query"
      ],
      "properties": {
        "query": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "shopping_search_sites",
    "description": "Serially run the portable store-entry plus replay-safe site search subflow for every selected Playground commerce site.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "stores",
        "query"
      ],
      "properties": {
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        },
        "query": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  {
    "name": "shopping_search_stores",
    "description": "Run the real store-search subflow for every selected store using the locked canonical product query.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "required": [
        "stores",
        "query",
        "identity_id"
      ],
      "properties": {
        "stores": {
          "type": "array",
          "minItems": 2,
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "site"
            ],
            "properties": {
              "site": {
                "type": "string",
                "enum": [
                  "amazon",
                  "walmart",
                  "ebay",
                  "aliexpress",
                  "etsy",
                  "coupang",
                  "naver-shopping",
                  "gmarket",
                  "11st",
                  "ssg"
                ]
              }
            }
          }
        },
        "query": {
          "type": "string",
          "minLength": 1
        },
        "quantity": {
          "type": [
            "integer",
            "number"
          ]
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_kind": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_category": {
          "type": [
            "string",
            "null"
          ]
        },
        "query_variants": {
          "type": [
            "string",
            "null"
          ]
        },
        "brand_aliases": {
          "type": [
            "string",
            "null"
          ]
        },
        "locked_hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "shopping_summarize_store_outcomes",
    "description": "Emit a bounded post-screening outcome and sample for every searched store.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      }
    }
  },
  {
    "name": "shopping_verify_product_offers",
    "description": "Classify live offers against the locked model and hard variants before ranking.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "store_results",
        "identity_id",
        "identity_kind"
      ],
      "properties": {
        "store_results": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "identity_id": {
          "type": "string",
          "minLength": 1
        },
        "identity_kind": {
          "type": "string",
          "enum": [
            "standardized_model",
            "spec_equivalent",
            "unique_listing"
          ]
        },
        "identity_brand": {
          "type": [
            "string",
            "null"
          ]
        },
        "identity_model": {
          "type": [
            "string",
            "null"
          ]
        },
        "product_category": {
          "type": [
            "string",
            "null"
          ]
        },
        "locked_hard_constraints": {
          "type": [
            "object",
            "null"
          ],
          "additionalProperties": true
        }
      }
    }
  },
  {
    "name": "site_entry",
    "description": "Route a fresh site-assistant entry into the site handoff without a remote round trip.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {}
    }
  },
  {
    "name": "verify_request",
    "description": "Check that service_query, user_requirements, a five-digit zip_code, and all four contact fields are present before search. Pure check; no navigation or side effects.",
    "parameters": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "service_query": {
          "type": [
            "string",
            "null"
          ]
        },
        "user_requirements": {
          "type": [
            "string",
            "null"
          ]
        },
        "zip_code": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_first_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_last_name": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_email": {
          "type": [
            "string",
            "null"
          ]
        },
        "submit_phone": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    }
  },
  {
    "name": "write_captured_memory",
    "description": "Write the captured entries to the on-device memory store. One round trip; an absent value deletes.",
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "memory"
      ],
      "properties": {
        "confirmed": {
          "type": "boolean"
        },
        "memory": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        }
      }
    }
  }
]
